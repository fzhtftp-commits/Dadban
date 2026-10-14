import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const databaseUrl = process.env.DADBAN_TEST_DATABASE_URL;
const origin = "http://localhost:5500";
const port = 18765;
const baseUrl = `http://127.0.0.1:${port}`;
const tokenA = "test-session-office-a-" + randomBytes(24).toString("hex");
const csrfA = "test-csrf-office-a-" + randomBytes(24).toString("hex");
const tokenB = "test-session-office-b-" + randomBytes(24).toString("hex");
const csrfB = "test-csrf-office-b-" + randomBytes(24).toString("hex");
const tokenExpired = "test-session-expired-" + randomBytes(24).toString("hex");
const csrfExpired = "test-csrf-expired-" + randomBytes(24).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ids = {
  officeA: "10000000-0000-4000-8000-000000000001",
  officeB: "10000000-0000-4000-8000-000000000002",
  userA: "20000000-0000-4000-8000-000000000001",
  userB: "20000000-0000-4000-8000-000000000002",
  clientA: "30000000-0000-4000-8000-000000000001",
  clientB: "30000000-0000-4000-8000-000000000002",
  caseA1: "40000000-0000-4000-8000-000000000001",
  caseA2: "40000000-0000-4000-8000-000000000002",
  caseB: "40000000-0000-4000-8000-000000000003"
};

let db;
let server;
let serverOutput = "";
let hearingId;
const cookie = (token, csrf) => `dadban_session=${token}; dadban_csrf=${csrf}`;
const headersA = { cookie: cookie(tokenA, csrfA), origin, "x-csrf-token": csrfA, "content-type": "application/json" };
const headersB = { cookie: cookie(tokenB, csrfB), origin, "x-csrf-token": csrfB, "content-type": "application/json" };
const headersBadCsrf = { ...headersA, cookie: cookie(tokenA, "incorrect-csrf-token"), "x-csrf-token": "incorrect-csrf-token" };
const headersBadOrigin = { ...headersA, origin: "https://attacker.example" };
const headersExpired = { cookie: cookie(tokenExpired, csrfExpired), origin, "x-csrf-token": csrfExpired, "content-type": "application/json" };
const future = (days) => new Date(Date.now() + days * 86400000);
const iso = (date) => date.toISOString();
async function assertStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`Expected HTTP ${expected}, got ${response.status}: ${await response.text()}`);
  }
}
async function api(route, { method = "GET", headers = headersA, body } = {}) {
  return fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function waitForServer() {
  let lastError;
  for (let i = 0; i < 80; i += 1) {
    if (server.exitCode !== null) throw new Error("API process exited early: " + serverOutput);
    try {
      const response = await fetch(baseUrl + "/health");
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error("API did not start: " + String(lastError) + "\n" + serverOutput);
}

before(async () => {
  assert.ok(databaseUrl, "DADBAN_TEST_DATABASE_URL must point to a dedicated local test database");
  const parsed = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname), "Refusing to run integration tests against a non-local database");
  assert.match(parsed.pathname, /^\/dadban_test$/, "Database name must be exactly dadban_test");
  db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const schema = await readFile(path.join(root, "database/schema.sql"), "utf8");
  await db.query(schema);
  await db.query("insert into offices (id, name) values ($1, $2), ($3, $4)", [ids.officeA, "دفتر آزمایشی الف", ids.officeB, "دفتر آزمایشی ب"]);
  await db.query("insert into users (id, office_id, full_name, email, role) values ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)", [ids.userA, ids.officeA, "کاربر آزمایشی الف", "office-a@example.test", "owner", ids.userB, ids.officeB, "کاربر آزمایشی ب", "office-b@example.test", "owner"]);
  await db.query("insert into clients (id, office_id, client_type, full_name, national_id) values ($1, $2, 'individual', $3, $4), ($5, $6, 'individual', $7, $8)", [ids.clientA, ids.officeA, "موکل الف", "0012345678", ids.clientB, ids.officeB, "موکل ب", "0012345679"]);
  await db.query("insert into cases (id, office_id, client_id, case_number, title) values ($1, $2, $3, $4, $5), ($6, $2, $3, $7, $8), ($9, $10, $11, $12, $13)", [ids.caseA1, ids.officeA, ids.clientA, "A-001", "پرونده آزمایشی اول", ids.caseA2, "A-002", "پرونده آزمایشی دوم", ids.caseB, ids.officeB, ids.clientB, "B-001", "پرونده دفتر دیگر"]);
  await db.query("insert into auth_sessions (user_id, office_id, token_hash, csrf_hash, expires_at) values ($1, $2, $3, $4, now() + interval '1 hour'), ($5, $6, $7, $8, now() + interval '1 hour')", [ids.userA, ids.officeA, hash(tokenA), hash(csrfA), ids.userB, ids.officeB, hash(tokenB), hash(csrfB)]);
  await db.query("insert into auth_sessions (user_id, office_id, token_hash, csrf_hash, expires_at) values ($1, $2, $3, $4, $5)", [ids.userA, ids.officeA, hash(tokenExpired), hash(csrfExpired), new Date(Date.now() - 60000)]);
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: path.join(root, "backend"),
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test", CORS_ORIGIN: origin, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
  await waitForServer();
});

after(async () => {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (server) await Promise.race([new Promise((resolve) => server.once("exit", resolve)), delay(3000)]);
  if (db) await db.end();
});

test("hearing API integration: CRUD, filters, dashboard sync, and office isolation", async (t) => {
  await t.test("creates a hearing and syncs the dashboard next-hearing field", async () => {
    const hearingAt = future(3);
    const response = await api("/api/hearings", {
      method: "POST",
      body: { case_id: ids.caseA1, hearing_at: iso(hearingAt), hearing_type: "جلسه آزمون", reminder_minutes: 1440 }
    });
    await assertStatus(response, 201);
    const result = await response.json();
    hearingId = result.data.id;
    assert.equal(result.data.case_id, ids.caseA1);
    const caseResult = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA1]);
    assert.ok(Math.abs(new Date(caseResult.rows[0].next_hearing_at).getTime() - hearingAt.getTime()) < 1500);
    const dashboard = await api("/api/dashboard");
    assert.equal(dashboard.status, 200);
    const dashboardData = (await dashboard.json()).data;
    assert.equal(dashboardData.stats.upcoming_hearings, 1);
    assert.equal(dashboardData.upcoming_hearings[0].id, ids.caseA1);
  });

  await t.test("parameterized date/status filters work and reversed date ranges are rejected", async () => {
    const from = new Date(Date.now() + 2 * 86400000);
    const to = new Date(Date.now() + 4 * 86400000);
    const filtered = await api("/api/hearings?from=" + encodeURIComponent(iso(from)) + "&to=" + encodeURIComponent(iso(to)) + "&status=scheduled");
    await assertStatus(filtered, 200);
    assert.equal((await filtered.json()).data.length, 1);
    const reversed = await api("/api/hearings?from=" + encodeURIComponent(iso(to)) + "&to=" + encodeURIComponent(iso(from)));
    assert.equal(reversed.status, 400);
    assert.equal((await reversed.json()).error, "invalid_date_range");
  });

  await t.test("updates hearing and recomputes next-hearing date", async () => {
    const movedTo = future(5);
    const response = await api("/api/hearings/" + hearingId, {
      method: "PATCH", body: { hearing_at: iso(movedTo), status: "postponed" }
    });
    await assertStatus(response, 200);
    const caseResult = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA1]);
    assert.ok(Math.abs(new Date(caseResult.rows[0].next_hearing_at).getTime() - movedTo.getTime()) < 1500);
  });

  await t.test("moving a hearing updates both cases; cancelled hearings are excluded", async () => {
    const movedTo = future(6);
    const moved = await api("/api/hearings/" + hearingId, {
      method: "PATCH", body: { case_id: ids.caseA2, hearing_at: iso(movedTo), status: "scheduled" }
    });
    await assertStatus(moved, 200);
    const oldCase = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA1]);
    const newCase = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA2]);
    assert.equal(oldCase.rows[0].next_hearing_at, null);
    assert.ok(Math.abs(new Date(newCase.rows[0].next_hearing_at).getTime() - movedTo.getTime()) < 1500);
    const cancelled = await api("/api/hearings/" + hearingId, { method: "PATCH", body: { status: "cancelled" } });
    await assertStatus(cancelled, 200);
    const cancelledCase = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA2]);
    assert.equal(cancelledCase.rows[0].next_hearing_at, null);
  });

  await t.test("office B cannot list, read, modify, delete, or attach office A hearings/cases", async () => {
    const newResponse = await api("/api/hearings", {
      method: "POST", headers: headersA,
      body: { case_id: ids.caseA1, hearing_at: iso(future(7)), hearing_type: "جلسه جداسازی" }
    });
    await assertStatus(newResponse, 201);
    const officeAHearingId = (await newResponse.json()).data.id;
    const listB = await api("/api/hearings", { headers: headersB });
    assert.equal(listB.status, 200);
    assert.equal((await listB.json()).data.length, 0);
    const readB = await api("/api/hearings/" + officeAHearingId, { headers: headersB });
    assert.equal(readB.status, 404);
    const patchB = await api("/api/hearings/" + officeAHearingId, { method: "PATCH", headers: headersB, body: { hearing_type: "غیرمجاز" } });
    assert.equal(patchB.status, 404);
    const deleteB = await api("/api/hearings/" + officeAHearingId, { method: "DELETE", headers: headersB });
    assert.equal(deleteB.status, 404);
    const crossOfficeCreate = await api("/api/hearings", {
      method: "POST", headers: headersB,
      body: { case_id: ids.caseA1, hearing_at: iso(future(8)), hearing_type: "جلسه نامعتبر" }
    });
    assert.equal(crossOfficeCreate.status, 400);
    assert.equal((await db.query("select deleted_at from hearings where id = $1", [officeAHearingId])).rows[0].deleted_at, null);
  });


  await t.test("expired sessions are rejected before hearing data is exposed", async () => {
    const list = await api("/api/hearings", { headers: headersExpired });
    assert.equal(list.status, 401);
    assert.equal((await list.json()).error, "authentication_required");
    const create = await api("/api/hearings", { method: "POST", headers: headersExpired, body: { case_id: ids.caseA1, hearing_at: iso(future(2)), hearing_type: "نشست منقضی" } });
    assert.equal(create.status, 401);
    assert.equal((await create.json()).error, "authentication_required");
  });

  await t.test("invalid CSRF token and untrusted origin reject mutations without changing records", async () => {
    const created = await api("/api/hearings", { method: "POST", body: { case_id: ids.caseA1, hearing_at: iso(future(10)), hearing_type: "جلسه حفاظت CSRF" } });
    await assertStatus(created, 201);
    const id = (await created.json()).data.id;
    const badCreate = await api("/api/hearings", { method: "POST", headers: headersBadCsrf, body: { case_id: ids.caseA1, hearing_at: iso(future(11)), hearing_type: "نباید ثبت شود" } });
    assert.equal(badCreate.status, 403);
    assert.equal((await badCreate.json()).error, "csrf_token_invalid");
    const badPatch = await api("/api/hearings/" + id, { method: "PATCH", headers: headersBadCsrf, body: { hearing_type: "نباید تغییر کند" } });
    assert.equal(badPatch.status, 403);
    assert.equal((await badPatch.json()).error, "csrf_token_invalid");
    const badDelete = await api("/api/hearings/" + id, { method: "DELETE", headers: headersBadCsrf });
    assert.equal(badDelete.status, 403);
    assert.equal((await badDelete.json()).error, "csrf_token_invalid");
    const badOrigin = await api("/api/hearings/" + id, { method: "PATCH", headers: headersBadOrigin, body: { hearing_type: "origin نامعتبر" } });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error, "origin_not_allowed");
    const unchanged = await db.query("select hearing_type, deleted_at from hearings where id = $1", [id]);
    assert.equal(unchanged.rows[0].hearing_type, "جلسه حفاظت CSRF");
    assert.equal(unchanged.rows[0].deleted_at, null);
    const count = await db.query("select count(*)::int as n from hearings where office_id = $1 and hearing_type = $2 and deleted_at is null", [ids.officeA, "نباید ثبت شود"]);
    assert.equal(count.rows[0].n, 0);
  });

  await t.test("invalid hearing identifiers and malformed payloads return controlled errors", async () => {
    const get = await api("/api/hearings/not-a-uuid");
    assert.equal(get.status, 400);
    assert.equal((await get.json()).error, "invalid_hearing_id");
    const patch = await api("/api/hearings/not-a-uuid", { method: "PATCH", body: { hearing_type: "نامعتبر" } });
    assert.equal(patch.status, 400);
    assert.equal((await patch.json()).error, "invalid_hearing_id");
    const del = await api("/api/hearings/not-a-uuid", { method: "DELETE" });
    assert.equal(del.status, 400);
    assert.equal((await del.json()).error, "invalid_hearing_id");
    const badPayload = await api("/api/hearings", { method: "POST", body: { case_id: "not-a-uuid", hearing_at: "tomorrow", hearing_type: "" } });
    assert.equal(badPayload.status, 400);
    assert.equal((await badPayload.json()).error, "invalid_hearing");
    const missing = await api("/api/hearings/40000000-0000-4000-8000-000000000099", { method: "PATCH", body: { hearing_type: "جلسه" } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "hearing_not_found");
  });

  await t.test("soft delete hides the hearing, writes audit history, and clears dashboard date", async () => {
    const create = await api("/api/hearings", {
      method: "POST", body: { case_id: ids.caseA2, hearing_at: iso(future(9)), hearing_type: "جلسه حذف نرم" }
    });
    await assertStatus(create, 201);
    const id = (await create.json()).data.id;
    const del = await api("/api/hearings/" + id, { method: "DELETE" });
    assert.equal(del.status, 204);
    const get = await api("/api/hearings/" + id);
    assert.equal(get.status, 404);
    const rows = await db.query("select deleted_at from hearings where id = $1", [id]);
    assert.ok(rows.rows[0].deleted_at);
    const audit = await db.query("select count(*)::int as n from audit_logs where entity_type = 'hearing' and entity_id = $1 and action = 'delete'", [id]);
    assert.equal(audit.rows[0].n, 1);
    const caseDate = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA2]);
    assert.equal(caseDate.rows[0].next_hearing_at, null);
  });
});
