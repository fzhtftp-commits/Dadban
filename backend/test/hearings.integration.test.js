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
const future = (days) => new Date(Date.now() + days * 86400000);
const iso = (date) => date.toISOString();
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
    assert.equal(response.status, 201, await response.text());
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
    assert.equal(filtered.status, 200, await filtered.text());
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
    assert.equal(response.status, 200, await response.text());
    const caseResult = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA1]);
    assert.ok(Math.abs(new Date(caseResult.rows[0].next_hearing_at).getTime() - movedTo.getTime()) < 1500);
  });

  await t.test("moving a hearing updates both cases; cancelled hearings are excluded", async () => {
    const movedTo = future(6);
    const moved = await api("/api/hearings/" + hearingId, {
      method: "PATCH", body: { case_id: ids.caseA2, hearing_at: iso(movedTo), status: "scheduled" }
    });
    assert.equal(moved.status, 200, await moved.text());
    const oldCase = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA1]);
    const newCase = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA2]);
    assert.equal(oldCase.rows[0].next_hearing_at, null);
    assert.ok(Math.abs(new Date(newCase.rows[0].next_hearing_at).getTime() - movedTo.getTime()) < 1500);
    const cancelled = await api("/api/hearings/" + hearingId, { method: "PATCH", body: { status: "cancelled" } });
    assert.equal(cancelled.status, 200, await cancelled.text());
    const cancelledCase = await db.query("select next_hearing_at from cases where id = $1", [ids.caseA2]);
    assert.equal(cancelledCase.rows[0].next_hearing_at, null);
  });

  await t.test("office B cannot list, read, modify, delete, or attach office A hearings/cases", async () => {
    const newResponse = await api("/api/hearings", {
      method: "POST", headers: headersA,
      body: { case_id: ids.caseA1, hearing_at: iso(future(7)), hearing_type: "جلسه جداسازی" }
    });
    assert.equal(newResponse.status, 201, await newResponse.text());
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

  await t.test("soft delete hides the hearing, writes audit history, and clears dashboard date", async () => {
    const create = await api("/api/hearings", {
      method: "POST", body: { case_id: ids.caseA2, hearing_at: iso(future(9)), hearing_type: "جلسه حذف نرم" }
    });
    assert.equal(create.status, 201, await create.text());
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
