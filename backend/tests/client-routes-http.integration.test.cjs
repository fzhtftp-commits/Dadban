const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Client } = require("pg");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must point to the isolated CI PostgreSQL service");

const host = "127.0.0.1";
const port = Number(process.env.DADBANTEST_PORT || 18765);
const origin = "http://localhost:5500";
const sessionToken = "integration-test-session-token-with-more-than-forty-characters";
const csrfToken = "integration-test-csrf-token";
const userId = "00000000-0000-4000-8000-000000000001";
const officeId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const otherOfficeId = "00000000-0000-4000-8000-000000000004";
const otherOfficeClientId = "00000000-0000-4000-8000-000000000005";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const cookie = `dadban_session=${sessionToken}; dadban_csrf=${csrfToken}`;
const headers = {
  origin,
  cookie,
  "content-type": "application/json",
  "x-csrf-token": csrfToken
};

let server;
let db;
let serverOutput = "";

async function waitForHealth(child) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited before becoming healthy. Output:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`http://${host}:${port}/health`);
      if (response.ok) return;
      lastError = new Error(`Health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Backend did not become healthy: ${lastError}\n${serverOutput}`);
}

async function resetIsolatedSchema() {
  await db.query("drop table if exists audit_logs, clients, auth_sessions, users, offices cascade");
  await db.query(`
    create table offices (
      id uuid primary key,
      name text not null
    );
    create table users (
      id uuid primary key,
      office_id uuid not null references offices(id),
      full_name text not null,
      email text not null unique,
      role text not null,
      is_active boolean not null default true,
      deleted_at timestamptz
    );
    create table auth_sessions (
      id uuid primary key,
      user_id uuid not null references users(id),
      office_id uuid not null references offices(id),
      token_hash text not null unique,
      csrf_hash text not null,
      revoked_at timestamptz,
      expires_at timestamptz not null,
      last_seen_at timestamptz
    );
    create table clients (
      id uuid primary key default gen_random_uuid(),
      office_id uuid not null references offices(id),
      client_type text not null check (client_type in ('individual', 'company')),
      full_name text,
      national_id text,
      birth_date date,
      occupation text,
      company_name text,
      national_company_id text,
      registration_no text,
      mobile text,
      phone text,
      email text,
      source text,
      address text,
      notes text,
      status text not null default 'active',
      created_by uuid not null references users(id),
      updated_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );
    create table audit_logs (
      id uuid primary key default gen_random_uuid(),
      office_id uuid not null references offices(id),
      user_id uuid not null references users(id),
      action text not null,
      entity_type text not null,
      entity_id uuid not null,
      metadata jsonb,
      ip_address inet,
      user_agent text,
      created_at timestamptz not null default now()
    );
  `);
  await db.query("insert into offices (id, name) values ($1, $2), ($3, $4)", [officeId, "Integration Test Office", otherOfficeId, "Other Integration Test Office"]);
  await db.query(
    "insert into users (id, office_id, full_name, email, role) values ($1, $2, $3, $4, $5)",
    [userId, officeId, "Integration Test User", "dadban-http-test@example.invalid", "owner"]
  );
  await db.query(
    "insert into auth_sessions (id, user_id, office_id, token_hash, csrf_hash, expires_at) values ($1, $2, $3, $4, $5, now() + interval '1 hour')",
    [sessionId, userId, officeId, hash(sessionToken), hash(csrfToken)]
  );
  await db.query(
    "insert into clients (id, office_id, client_type, full_name, national_id, created_by, updated_by) values ($1, $2, 'individual', $3, $4, $5, $5)",
    [otherOfficeClientId, otherOfficeId, "Other Office Client", "1234567891", userId]
  );
}

test("real HTTP client routes enforce checksum and CSRF, and accept valid create/edit", async t => {
  db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await resetIsolatedSchema();

  server = spawn(process.execPath, ["src/server.js"], {
    cwd: require("node:path").resolve(__dirname, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      CORS_ORIGIN: origin,
      DATABASE_URL: databaseUrl
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
  server.stderr.on("data", chunk => { serverOutput += chunk.toString(); });
  await waitForHealth(server);

  t.after(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise(resolve => {
        const timeout = setTimeout(() => { server.kill("SIGKILL"); resolve(); }, 3000);
        server.once("exit", () => { clearTimeout(timeout); resolve(); });
      });
    }
    if (db) {
      await db.query("drop table if exists audit_logs, clients, auth_sessions, users, offices cascade");
      await db.end();
    }
  });

  const request = (path, method, body, extraHeaders = {}) =>
    fetch(`http://${host}:${port}${path}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  const validClient = {
    client_type: "individual",
    full_name: "علی رضایی",
    national_id: "1234567891",
    mobile: "09123456789"
  };

  await t.test("POST /api/clients returns 400 for an invalid checksum", async () => {
    const response = await request("/api/clients", "POST", { ...validClient, national_id: "1234567890" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_client" });
    assert.equal((await db.query("select count(*)::int as count from clients")).rows[0].count, 0);
  });

  await t.test("PATCH /api/clients/:id returns 400 for an invalid checksum", async () => {
    const response = await request(`/api/clients/${userId}`, "PATCH", { national_id: "1234567890" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_client_update" });
    assert.equal((await db.query("select count(*)::int as count from clients")).rows[0].count, 0);
  });

  await t.test("POST /api/clients returns 403 for an invalid CSRF token", async () => {
    const response = await request("/api/clients", "POST", validClient, { cookie: `dadban_session=${sessionToken}; dadban_csrf=wrong-csrf-token`, "x-csrf-token": "wrong-csrf-token" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "csrf_token_invalid" });
    assert.equal((await db.query("select count(*)::int as count from clients")).rows[0].count, 0);
  });

  await t.test("GET detail and national-code lookup never disclose another office's client", async () => {
    const detail = await request("/api/clients/" + otherOfficeClientId, "GET");
    assert.equal(detail.status, 404);
    assert.deepEqual(await detail.json(), { error: "client_not_found" });
    const lookup = await request("/api/clients/lookup?national_id=1234567891", "GET");
    assert.equal(lookup.status, 404);
    assert.deepEqual(await lookup.json(), { error: "client_not_found" });
  });

  await t.test("PATCH cannot update a client belonging to another office", async () => {
    const response = await request("/api/clients/" + otherOfficeClientId, "PATCH", { full_name: "Unauthorized change" });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "client_not_found" });
    const stored = await db.query("select full_name from clients where id = $1", [otherOfficeClientId]);
    assert.equal(stored.rows[0].full_name, "Other Office Client");
  });

  let clientId;
  await t.test("POST /api/clients returns 201 and persists a valid client", async () => {
    const response = await request("/api/clients", "POST", validClient);
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.data.national_id, "1234567891");
    assert.equal(payload.data.full_name, validClient.full_name);
    assert.ok(payload.data.id);
    clientId = payload.data.id;
    const stored = await db.query("select national_id, full_name from clients where id = $1", [clientId]);
    assert.deepEqual(stored.rows[0], { national_id: "1234567891", full_name: validClient.full_name });
    assert.equal((await db.query("select count(*)::int as count from audit_logs where action = 'create' and entity_id = $1", [clientId])).rows[0].count, 1);
  });

  await t.test("PATCH /api/clients/:id returns 200 and persists a valid edit", async () => {
    assert.ok(clientId, "the create scenario must provide a client ID");
    const response = await request(`/api/clients/${clientId}`, "PATCH", { full_name: "علی رضایی ویرایش‌شده", national_id: "۱۲۳۴۵۶۷۸۹۱" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.full_name, "علی رضایی ویرایش‌شده");
    assert.equal(payload.data.national_id, "1234567891");
    const stored = await db.query("select full_name, national_id from clients where id = $1", [clientId]);
    assert.deepEqual(stored.rows[0], { full_name: "علی رضایی ویرایش‌شده", national_id: "1234567891" });
    assert.equal((await db.query("select count(*)::int as count from audit_logs where action = 'update' and entity_id = $1", [clientId])).rows[0].count, 1);
  })
  await t.test("client creation rolls back when audit-log insertion fails", async () => {
    await db.query("create function fail_audit_insert() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit sink failure'; end; $$; create trigger fail_audit_insert_before_write before insert on audit_logs for each row execute function fail_audit_insert();");
    try {
      const response = await request("/api/clients", "POST", { ...validClient, full_name: "Must Roll Back" });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "database_error" });
      assert.equal((await db.query("select count(*)::int as count from clients where full_name = $1", ["Must Roll Back"])).rows[0].count, 0);
      assert.equal((await db.query("select count(*)::int as count from audit_logs where action = 'create'")).rows[0].count, 1);
    } finally {
      await db.query("drop trigger if exists fail_audit_insert_before_write on audit_logs");
      await db.query("drop function if exists fail_audit_insert()");
    }
  });
;
});
