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
  caseB: "40000000-0000-4000-8000-000000000003",
  userInactiveA: "20000000-0000-4000-8000-000000000003"
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
  const caseActionsMigration = await readFile(path.join(root, "database/migrations/20261014_case_actions.sql"), "utf8");
  await db.query(caseActionsMigration);
  const caseDocumentsMigration = await readFile(path.join(root, "database/migrations/20261014_case_documents_metadata.sql"), "utf8");
  await db.query(caseDocumentsMigration);
  await db.query("insert into offices (id, name) values ($1, $2), ($3, $4)", [ids.officeA, "دفتر آزمایشی الف", ids.officeB, "دفتر آزمایشی ب"]);
  await db.query("insert into users (id, office_id, full_name, email, role) values ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)", [ids.userA, ids.officeA, "کاربر آزمایشی الف", "office-a@example.test", "owner", ids.userB, ids.officeB, "کاربر آزمایشی ب", "office-b@example.test", "owner"]);
  await db.query("insert into users (id, office_id, full_name, email, role, is_active) values ($1, $2, $3, $4, $5, false)", [ids.userInactiveA, ids.officeA, "کاربر غیرفعال", "inactive-a@example.test", "assistant"]);
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


test("case action API: CRUD, validation, audit, and office isolation", async (t) => {
  let actionId;
  await t.test("assignee picker lists only active users from the authenticated office", async () => {
    const response = await api("/api/actions/assignees");
    await assertStatus(response, 200);
    const rows = (await response.json()).data;
    assert.ok(rows.some(user => user.id === ids.userA && user.role === "owner"));
    assert.ok(!rows.some(user => user.id === ids.userB));
    assert.ok(!rows.some(user => user.id === ids.userInactiveA));
    const officeB = await api("/api/actions/assignees", { headers: headersB });
    await assertStatus(officeB, 200);
    const rowsB = (await officeB.json()).data;
    assert.ok(rowsB.some(user => user.id === ids.userB));
    assert.ok(!rowsB.some(user => user.id === ids.userA));
  });

  await t.test("expired sessions and invalid CSRF cannot list or mutate case actions", async () => {
    const list = await api("/api/actions", { headers: headersExpired });
    assert.equal(list.status, 401);
    assert.equal((await list.json()).error, "authentication_required");
    const assignees = await api("/api/actions/assignees", { headers: headersExpired });
    assert.equal(assignees.status, 401);
    const create = await api("/api/actions", { method: "POST", headers: headersExpired, body: { case_id: ids.caseA1, title: "نشست منقضی" } });
    assert.equal(create.status, 401);
    const badCsrf = await api("/api/actions", { method: "POST", headers: headersBadCsrf, body: { case_id: ids.caseA1, title: "توکن نامعتبر" } });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error, "csrf_token_invalid");
  });

  await t.test("rejects inactive same-office assignees and marks overdue open actions", async () => {
    const invalid = await api("/api/actions", { method: "POST", body: { case_id: ids.caseA1, title: "مسئول غیرفعال", assigned_to: ids.userInactiveA } });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_assignee");
    const created = await api("/api/actions", { method: "POST", body: { case_id: ids.caseA1, title: "پیگیری عقب‌افتاده", assigned_to: ids.userA, due_at: iso(new Date(Date.now() - 86400000)) } });
    await assertStatus(created, 201);
    const action = (await created.json()).data;
    assert.equal(action.assigned_to, ids.userA);
    const list = await api("/api/actions?case_id=" + ids.caseA1);
    await assertStatus(list, 200);
    const listed = (await list.json()).data.find(item => item.id === action.id);
    assert.equal(listed.assignee_name, "کاربر آزمایشی الف");
    assert.equal(listed.is_overdue, true);
    await api("/api/actions/" + action.id, { method: "DELETE" });
  });
  await t.test("creates an action linked to an office-owned case", async () => {
    const response = await api("/api/actions", {
      method: "POST",
      body: { case_id: ids.caseA1, title: "تهیه لایحه", description: "بررسی مستندات", due_at: iso(future(2)), priority: "high" }
    });
    await assertStatus(response, 201);
    const data = (await response.json()).data;
    actionId = data.id;
    assert.equal(data.office_id, ids.officeA);
    assert.equal(data.case_id, ids.caseA1);
    assert.equal(data.status, "todo");
    assert.equal(data.priority, "high");
    assert.equal(data.completed_at, null);
  });

  await t.test("lists and filters actions by case/status with office isolation", async () => {
    const filtered = await api("/api/actions?case_id=" + ids.caseA1 + "&status=todo");
    await assertStatus(filtered, 200);
    const rows = (await filtered.json()).data;
    assert.ok(rows.some(item => item.id === actionId));
    const listB = await api("/api/actions", { headers: headersB });
    await assertStatus(listB, 200);
    assert.equal((await listB.json()).data.length, 0);
    const invalid = await api("/api/actions?status=not-a-status");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_action_query");
  });

  await t.test("updates action status and stamps completion time", async () => {
    const response = await api("/api/actions/" + actionId, {
      method: "PATCH", body: { status: "completed", title: "تهیه و ثبت لایحه" }
    });
    await assertStatus(response, 200);
    const data = (await response.json()).data;
    assert.equal(data.status, "completed");
    assert.ok(data.completed_at);
    assert.equal(data.title, "تهیه و ثبت لایحه");
    const reopened = await api("/api/actions/" + actionId, {
      method: "PATCH", body: { status: "in_progress" }
    });
    await assertStatus(reopened, 200);
    assert.equal((await reopened.json()).data.completed_at, null);
  });

  await t.test("rejects cross-office cases and assignees", async () => {
    const foreignCase = await api("/api/actions", {
      method: "POST", body: { case_id: ids.caseB, title: "نباید به دفتر دیگر متصل شود" }
    });
    assert.equal(foreignCase.status, 400);
    assert.equal((await foreignCase.json()).error, "invalid_related_case");
    const foreignAssignee = await api("/api/actions", {
      method: "POST", body: { case_id: ids.caseA1, title: "مسئول نامعتبر", assigned_to: ids.userB }
    });
    assert.equal(foreignAssignee.status, 400);
    assert.equal((await foreignAssignee.json()).error, "invalid_assignee");
    const readB = await api("/api/actions/" + actionId, { headers: headersB });
    assert.equal(readB.status, 404);
    const patchB = await api("/api/actions/" + actionId, { method: "PATCH", headers: headersB, body: { title: "غیرمجاز" } });
    assert.equal(patchB.status, 404);
    const deleteB = await api("/api/actions/" + actionId, { method: "DELETE", headers: headersB });
    assert.equal(deleteB.status, 404);
  });

  await t.test("rejects invalid CSRF and malformed identifiers without mutation", async () => {
    const bad = await api("/api/actions/" + actionId, {
      method: "PATCH", headers: headersBadCsrf, body: { title: "نباید تغییر کند" }
    });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error, "csrf_token_invalid");
    const invalidId = await api("/api/actions/not-a-uuid");
    assert.equal(invalidId.status, 400);
    assert.equal((await invalidId.json()).error, "invalid_action_id");
    const invalidPayload = await api("/api/actions", {
      method: "POST", body: { case_id: ids.caseA1, title: "" }
    });
    assert.equal(invalidPayload.status, 400);
    assert.equal((await invalidPayload.json()).error, "invalid_action");
    const unchanged = await api("/api/actions/" + actionId);
    assert.equal(unchanged.status, 200);
    assert.equal((await unchanged.json()).data.title, "تهیه و ثبت لایحه");
  });

  await t.test("soft deletes action and records an audit event", async () => {
    const response = await api("/api/actions/" + actionId, { method: "DELETE" });
    assert.equal(response.status, 204);
    const hidden = await api("/api/actions/" + actionId);
    assert.equal(hidden.status, 404);
    const row = await db.query("select deleted_at from case_actions where id = $1", [actionId]);
    assert.ok(row.rows[0].deleted_at);
    const audit = await db.query("select count(*)::int as n from audit_logs where entity_type = 'case_action' and entity_id = $1 and action = 'delete'", [actionId]);
    assert.equal(audit.rows[0].n, 1);
  });
});


test("case document metadata API: validation, office isolation, CSRF, audit and soft delete", async (t) => {
  let documentId;
  await t.test("creates metadata only for a case in the authenticated office", async () => {
    const response = await api("/api/documents", {
      method: "POST",
      body: { case_id: ids.caseA1, title: "لایحه آزمایشی", document_type: "pleading", reference_number: "DOC-001", confidentiality: "confidential" }
    });
    await assertStatus(response, 201);
    const data = (await response.json()).data;
    documentId = data.id;
    assert.equal(data.office_id, ids.officeA);
    assert.equal(data.case_id, ids.caseA1);
    assert.equal(data.storage_status, "metadata_only");
    assert.equal(data.document_type, "pleading");
  });

  await t.test("lists only documents in the user's office and rejects foreign case references", async () => {
    const listA = await api("/api/documents");
    await assertStatus(listA, 200);
    assert.ok((await listA.json()).data.some(d => d.id === documentId));
    const listB = await api("/api/documents", { headers: headersB });
    await assertStatus(listB, 200);
    assert.equal((await listB.json()).data.length, 0);
    const foreignCase = await api("/api/documents", {
      method: "POST", body: { case_id: ids.caseB, title: "سند دفتر دیگر" }
    });
    assert.equal(foreignCase.status, 400);
    assert.equal((await foreignCase.json()).error, "invalid_related_case");
    const crossOfficeRead = await api("/api/documents/" + documentId, { headers: headersB });
    assert.equal(crossOfficeRead.status, 404);
  });

  await t.test("rejects invalid metadata, unsupported upload fields, and invalid CSRF", async () => {
    const invalid = await api("/api/documents", {
      method: "POST", body: { case_id: ids.caseA1, title: "x", file_url: "https://example.test/file.pdf" }
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_document");
    const badCsrf = await api("/api/documents/" + documentId, {
      method: "PATCH", headers: headersBadCsrf, body: { title: "نباید ذخیره شود" }
    });
    assert.equal(badCsrf.status, 403);
    assert.equal((await badCsrf.json()).error, "csrf_token_invalid");
    const unchanged = await api("/api/documents/" + documentId);
    assert.equal((await unchanged.json()).data.title, "لایحه آزمایشی");
  });

  await t.test("updates and soft-deletes metadata with audit records", async () => {
    const update = await api("/api/documents/" + documentId, {
      method: "PATCH", body: { title: "لایحه اصلاح‌شده", confidentiality: "restricted" }
    });
    await assertStatus(update, 200);
    assert.equal((await update.json()).data.title, "لایحه اصلاح‌شده");
    const remove = await api("/api/documents/" + documentId, { method: "DELETE" });
    assert.equal(remove.status, 204);
    const hidden = await api("/api/documents/" + documentId);
    assert.equal(hidden.status, 404);
    const row = await db.query("select deleted_at from case_documents where id = $1", [documentId]);
    assert.ok(row.rows[0].deleted_at);
    const audit = await db.query("select count(*)::int as n from audit_logs where entity_type = 'case_document' and entity_id = $1", [documentId]);
    assert.ok(audit.rows[0].n >= 3);
  });
});
