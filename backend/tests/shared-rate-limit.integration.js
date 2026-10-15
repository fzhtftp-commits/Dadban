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
