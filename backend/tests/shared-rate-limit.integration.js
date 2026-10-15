import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createPostgresRateLimiter } from "../src/shared-rate-limiter.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
assert.ok(connectionString, "DATABASE_URL must point to disposable CI PostgreSQL");

const poolA = new Pool({ connectionString, max: 8 });
const poolB = new Pool({ connectionString, max: 8 });
const secret = "ci-only-rate-limit-hmac-secret-at-least-32-bytes";
const originalError = console.error;
console.error = (...args) => {
  // Integration checks intentionally simulate failures; keep CI output sanitized.
  if (args[0] !== "Shared rate limiter unavailable") originalError(...args);
};

const invoke = (middleware, address) => new Promise((resolve) => {
  const headers = {};
  const response = {
    statusCode: 200,
    body: null,
    setHeader(name, value) { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; resolve({ status: this.statusCode, body, headers }); return this; }
  };
  middleware({ ip: address, socket: { remoteAddress: address } }, response, () => {
    resolve({ status: 200, headers });
  });
});

try {
  await poolA.query("DELETE FROM public.rate_limit_counters");

  // Separate limiter instances and separate pools model two independent backend
  // processes racing on the same client key.
  const limiterA = createPostgresRateLimiter(poolA, {
    secret, bucket: "login", maxRequests: 7, cleanupIntervalMs: 60_000
  });
  const limiterB = createPostgresRateLimiter(poolB, {
    secret, bucket: "login", maxRequests: 7, cleanupIntervalMs: 60_000
  });
  const attempts = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    invoke(i % 2 ? limiterA : limiterB, "192.0.2.44")
  ));
  assert.equal(attempts.filter(x => x.status === 200).length, 7,
    "atomic UPSERT must allow exactly the configured number across instances");
  assert.equal(attempts.filter(x => x.status === 429).length, 33,
    "all excess concurrent attempts must be rejected");
  assert.ok(attempts.filter(x => x.status === 429).every(x =>
    Number(x.headers["Retry-After"]) >= 1 &&
    x.body?.error === "rate_limit_exceeded"),
  "429 responses must have a positive Retry-After and generic body");

  const rows = await poolA.query(
    "SELECT bucket_name, key_digest, window_start, request_count, expires_at FROM public.rate_limit_counters"
  );
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].request_count, 40,
    "no increments may be lost under concurrency");
  assert.equal(rows.rows[0].key_digest.length, 32);
  assert.equal(Object.keys(rows.rows[0]).some(k =>
    /ip|email|agent|token|payload|office|user/i.test(k)), false,
  "counter rows must not expose raw request or identity fields");

  // PostgreSQL host(inet) canonicalization must unify equivalent IPv6 spellings.
  await poolA.query("DELETE FROM public.rate_limit_counters");
  const ipv6A = createPostgresRateLimiter(poolA, {
    secret, bucket: "register", maxRequests: 3, cleanupIntervalMs: 60_000
  });
  const ipv6B = createPostgresRateLimiter(poolB, {
    secret, bucket: "register", maxRequests: 3, cleanupIntervalMs: 60_000
  });
  const ipv6Results = await Promise.all([
    invoke(ipv6A, "2001:0db8:0000:0000:0000:0000:0000:0007"),
    invoke(ipv6B, "2001:db8::7"),
    invoke(ipv6A, "2001:db8::7"),
    invoke(ipv6B, "2001:db8::7")
  ]);
  assert.equal(ipv6Results.filter(x => x.status === 200).length, 3);
  assert.equal(ipv6Results.filter(x => x.status === 429).length, 1,
    "equivalent IPv6 representations must share a bucket");

  // Exercise the actual runtime role, not the PostgreSQL superuser used to
  // provision the disposable CI database.
  const roleNameResult = await poolA.query("SELECT current_user AS name");
  const roleName = () => roleNameResult.rows[0].name;
  const roleCheck = await poolA.query(`
    SELECT r.rolsuper,
      has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
      has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
      pg_get_userbyid(n.nspowner) AS schema_owner,
      pg_get_userbyid(c.relowner) AS table_owner,
      c.relowner = r.oid AS owns_table,
      (SELECT count(*)::integer
         FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
        WHERE acl.grantee = 0) AS public_table_privilege_count,
      (SELECT count(*)::integer
         FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
        WHERE acl.grantee = 0) AS public_schema_privilege_count,
      has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
      has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
      has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
      has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
      has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate,
      has_table_privilege(current_user, c.oid, 'REFERENCES') AS can_reference,
      has_table_privilege(current_user, c.oid, 'TRIGGER') AS can_trigger
    FROM pg_roles r
    JOIN pg_class c ON c.oid = 'public.rate_limit_counters'::regclass
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE r.rolname = current_user
  `);
  const role = roleCheck.rows[0];
  assert.ok(role, "must resolve the effective connected role and counter table");
  assert.equal(role.rolsuper, false, "rate-limit integration must not run as a superuser");
  assert.equal(role.schema_usage, true);
  assert.equal(role.schema_create, false, "runtime role must not create objects in public");
  assert.equal(role.owns_table, false, "runtime role must not own the counter table");
  assert.equal(role.public_table_privilege_count, 0, "PUBLIC must have no direct counter-table privileges");
  assert.equal(role.public_schema_privilege_count, 0, "PUBLIC must have no direct public-schema privileges");
  for (const privilege of ["can_select", "can_insert", "can_update", "can_delete"]) {
    assert.equal(role[privilege], true, `runtime role requires ${privilege}`);
  }
  for (const privilege of ["can_truncate", "can_reference", "can_trigger"]) {
    assert.equal(role[privilege], false, `runtime role must not have ${privilege}`);
  }

  // Verify effective DDL denial, not only ACL/catalog snapshots. These attempts
  // target the disposable CI database and must fail with insufficient_privilege.
  await assert.rejects(
    poolA.query("CREATE TABLE public.rate_limit_role_ddl_probe (id integer)"),
    error => error?.code === "42501",
    "runtime role must not create schema objects"
  );
  await assert.rejects(
    poolA.query("ALTER TABLE public.rate_limit_counters ADD COLUMN ddl_probe integer"),
    error => error?.code === "42501",
    "runtime role must not alter an owned-by-another-role table"
  );

  // IPv4-mapped IPv6 must share the same counter bucket as its IPv4 address.
  await poolA.query("DELETE FROM public.rate_limit_counters");
  const mappedA = createPostgresRateLimiter(poolA, {
    secret, bucket: "register", maxRequests: 2, cleanupIntervalMs: 60_000
  });
  const mappedB = createPostgresRateLimiter(poolB, {
    secret, bucket: "register", maxRequests: 2, cleanupIntervalMs: 60_000
  });
  const mappedResults = await Promise.all([
    invoke(mappedA, "192.0.2.123"),
    invoke(mappedB, "::ffff:192.0.2.123"),
    invoke(mappedA, "::ffff:c000:027b")
  ]);
  assert.equal(mappedResults.filter(x => x.status === 200).length, 2);
  assert.equal(mappedResults.filter(x => x.status === 429).length, 1,
    "IPv4 and IPv4-mapped IPv6 representations must share a bucket");
  const mappedRows = await poolA.query("SELECT count(*)::integer AS n FROM public.rate_limit_counters");
  assert.equal(mappedRows.rows[0].n, 1, "mapped and IPv4 requests must produce one digest row");

  // Cleanup is bounded to one batch of 500 even when more rows have expired.
  await poolA.query("DELETE FROM public.rate_limit_counters");
  await poolA.query(`
    INSERT INTO public.rate_limit_counters
      (bucket_name, key_digest, window_start, request_count, expires_at)
    SELECT 'login',
      decode(md5('cleanup-a-' || n::text) || md5('cleanup-b-' || n::text), 'hex'),
      clock_timestamp() - interval '1 hour',
      1,
      clock_timestamp() - interval '1 second'
    FROM generate_series(1, 510) AS n
  `);
  const cleanupLimiter = createPostgresRateLimiter(poolA, {
    secret, bucket: "login", maxRequests: 10, cleanupIntervalMs: 60_000
  });
  const cleanupResponse = await invoke(cleanupLimiter, "192.0.2.88");
  assert.equal(cleanupResponse.status, 200);
  let expiredCount = 510;
  for (let attempt = 0; attempt < 30 && expiredCount > 10; attempt += 1) {
    await delay(25);
    const remaining = await poolA.query(
      "SELECT count(*)::integer AS n FROM public.rate_limit_counters WHERE expires_at <= clock_timestamp()"
    );
    expiredCount = remaining.rows[0].n;
  }
  assert.equal(expiredCount, 10,
    "each cleanup invocation must delete no more than 500 expired rows");

  assert.throws(() => createPostgresRateLimiter(poolA, {
    secret: "too-short", bucket: "login", maxRequests: 10
  }), /at least 32 bytes/);
  assert.throws(() => createPostgresRateLimiter(poolA, {
    secret, bucket: "unknown", maxRequests: 10
  }), /Unknown rate-limit bucket/);

  // A DB outage must fail with sanitized 503, never 429 and never memory fallback.
  const brokenPool = { async query() { throw Object.assign(new Error("private connection details"), { code: "08006" }); } };
  const failingLimiter = createPostgresRateLimiter(brokenPool, {
    secret, bucket: "login", maxRequests: 10
  });
  const failed = await invoke(failingLimiter, "192.0.2.99");
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, { error: "rate_limit_unavailable" });

  // Ensure async best-effort cleanup has settled before the pools are closed.
  await delay(30);
  console.log("shared PostgreSQL rate limiter integration checks passed");
} finally {
  console.error = originalError;
  await Promise.all([poolA.end(), poolB.end()]);
}
