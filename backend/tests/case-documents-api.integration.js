import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { readFile } from "node:fs/promises";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const parsedDatabaseUrl = databaseUrl ? new URL(databaseUrl) : null;
if (!parsedDatabaseUrl || !["localhost", "127.0.0.1"].includes(parsedDatabaseUrl.hostname) || parsedDatabaseUrl.pathname !== "/dadban_test") {
  throw new Error("Integration test may only reset the dedicated localhost /dadban_test database");
}
const port = Number(process.env.DADBAN_TEST_PORT || 18127);
const origin = "http://localhost:5500";
const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
let server;
let serverOutput = "";
let outageServer;
let outageServerOutput = "";
let timeoutServer;
let timeoutServerOutput = "";

const ids = {
  officeA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  officeB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  userB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
  caseA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
  caseB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02"
};
const tokenA = "test-session-office-a-".padEnd(48, "a");
const tokenB = "test-session-office-b-".padEnd(48, "b");
const csrfA = "test-csrf-office-a-".padEnd(48, "c");
const csrfB = "test-csrf-office-b-".padEnd(48, "d");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

async function waitForServer(portToCheck = port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${portToCheck}/health`);
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error("Dadban API did not become healthy in time");
}

async function request(path, { token, csrf, method = "GET", body, originHeader = origin, csrfHeader = true, idempotencyKey } = {}) {
  const headers = { origin: originHeader, cookie: `dadban_session=${token}; dadban_csrf=${csrf}` };
  if (csrfHeader && ["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    headers["x-csrf-token"] = csrf;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: { "retry-after": response.headers.get("retry-after") } };
}

try {
  // This script is only permitted to reset its dedicated, disposable localhost test DB.
  await pool.query(`
    drop table if exists case_documents cascade;
    drop table if exists audit_logs cascade;
    drop table if exists auth_sessions cascade;
    drop table if exists auth_credentials cascade;
    drop table if exists cases cascade;
    drop table if exists clients cascade;
    drop table if exists users cascade;
    drop table if exists offices cascade;
    create extension if not exists pgcrypto;
    create table offices (id uuid primary key, name text not null);
    create table users (
      id uuid primary key, office_id uuid not null references offices(id),
      full_name text not null, email text not null, role text not null default 'owner',
      is_active boolean not null default true, deleted_at timestamptz,
      unique (id, office_id)
    );
    create table cases (
      id uuid primary key, office_id uuid not null references offices(id),
      case_number text not null, title text not null, deleted_at timestamptz,
      unique (id, office_id)
    );
    create table auth_sessions (
      id uuid primary key default gen_random_uuid(), user_id uuid not null,
      office_id uuid not null, token_hash text not null, csrf_hash text not null,
      expires_at timestamptz not null, revoked_at timestamptz, last_seen_at timestamptz,
      foreign key (user_id, office_id) references users(id, office_id)
    );
    create table audit_logs (
      id uuid primary key default gen_random_uuid(), office_id uuid not null,
      user_id uuid not null, action text not null, entity_type text not null,
      entity_id uuid not null, metadata jsonb, ip_address text, user_agent text,
      created_at timestamptz not null default now()
    );
  `);

  const migration = await readFile(new URL("../migrations/004_case_documents_metadata.sql", import.meta.url), "utf8");
  await pool.query(migration);
  const indexCheck = await pool.query(`
    select indexname, indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'case_documents'
  `);
  const indexDefinitions = new Map(indexCheck.rows.map(row => [row.indexname, row.indexdef]));
  assert.ok(indexDefinitions.has("case_documents_office_case_created_idx"), "migration must create office/case/created partial index");
  assert.ok(indexDefinitions.get("case_documents_office_case_created_idx").includes("WHERE (deleted_at IS NULL)"), "active-document index should exclude soft-deleted rows");
  assert.ok(indexDefinitions.has("case_documents_office_created_idx"), "migration must create office/created listing index");
  assert.ok(indexDefinitions.get("case_documents_office_created_idx").includes("WHERE (deleted_at IS NULL)"), "office listing index should exclude soft-deleted rows");
  await pool.query("insert into offices(id,name) values ($1,'Office A'),($2,'Office B')", [ids.officeA, ids.officeB]);
  await pool.query("insert into users(id,office_id,full_name,email) values ($1,$2,'Test User A','a@example.test'),($3,$4,'Test User B','b@example.test')", [ids.userA,ids.officeA,ids.userB,ids.officeB]);
  await pool.query("insert into cases(id,office_id,case_number,title) values ($1,$2,'A-001','Case A'),($3,$4,'B-001','Case B')", [ids.caseA,ids.officeA,ids.caseB,ids.officeB]);
  await pool.query(`
    insert into auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) values
      ($1,$2,$3,$4,now()+interval '1 hour'),
      ($5,$6,$7,$8,now()+interval '1 hour')
  `, [ids.userA,ids.officeA,hash(tokenA),hash(csrfA),ids.userB,ids.officeB,hash(tokenB),hash(csrfB)]);

  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
  server.stderr.on("data", chunk => { serverOutput += chunk.toString(); });
  await waitForServer();

  const outagePort = port + 1;
  outageServer = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(outagePort), NODE_ENV: "test", DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/dadban_test", CORS_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"]
  });
  outageServer.stdout.on("data", chunk => { outageServerOutput += chunk.toString(); });
  outageServer.stderr.on("data", chunk => { outageServerOutput += chunk.toString(); });
  await waitForServer(outagePort);
  const outageResponse = await fetch(`http://127.0.0.1:${outagePort}/health/db`);
  assert.equal(outageResponse.status, 503, "database disconnect must return service unavailable");
  assert.deepEqual(await outageResponse.json(), { ok: false, database: "unavailable" }, "database outage response must not expose connection details");
  outageServer.kill("SIGTERM");
  outageServer = null;

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/case-documents`);
  assert.equal(unauthenticated.status, 401, "document listing must require a valid session");
  assert.deepEqual(await unauthenticated.json(), { error: "authentication_required" }, "unauthenticated response must remain generic");
  const invalidCsrf = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", csrfHeader: false,
    body: { case_id: ids.caseA, title: "Missing CSRF regression" }
  });
  assert.equal(invalidCsrf.status, 403, "mutation without CSRF token must be rejected");
  assert.deepEqual(invalidCsrf.body, { error: "csrf_token_required" }, "CSRF response must not reveal session internals");

  const wrongOrigin = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", originHeader: "https://attacker.example",
    body: { case_id: ids.caseA, title: "Rejected origin document" }
  });
  assert.equal(wrongOrigin.status, 403, "write with untrusted Origin must be rejected");

  const missingCsrf = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", csrfHeader: false,
    body: { case_id: ids.caseA, title: "Rejected CSRF document" }
  });
  assert.equal(missingCsrf.status, 403, "write without CSRF header must be rejected");

  const invalidDate = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Invalid date document", document_date: "2026-02-30" }
  });
  assert.equal(invalidDate.status, 400, "impossible calendar date must fail validation");
  const invalidDateUpdate = await request("/api/case-documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03", {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { document_date: "2026-02-30" }
  });
  assert.equal(invalidDateUpdate.status, 400, "impossible date must be rejected on update before document lookup");
  const forgedOffice = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Forged office metadata", office_id: ids.officeB }
  });
  assert.equal(forgedOffice.status, 400, "clients must not supply or override office_id");
  const forgedCaseUpdate = await request("/api/case-documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03", {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { case_id: ids.caseB }
  });
  assert.equal(forgedCaseUpdate.status, 400, "patch must not permit changing the document's linked case");
  const unknownMetadata = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Unknown metadata", storage_key: "private/path.pdf" }
  });
  assert.equal(unknownMetadata.status, 400, "storage metadata and unknown fields must be rejected in metadata-only phase");
  const emptyPatch = await request("/api/case-documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03", {
    token: tokenA, csrf: csrfA, method: "PATCH", body: {}
  });
  assert.equal(emptyPatch.status, 400, "empty patch must be rejected");

  const oversizedTitle = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", body: { case_id: ids.caseA, title: "T".repeat(201) }
  });
  assert.equal(oversizedTitle.status, 400, "title above 200 characters must be rejected");
  const negativeSize = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", body: { case_id: ids.caseA, title: "Negative size", size_bytes: -1 }
  });
  assert.equal(negativeSize.status, 400, "negative metadata size must be rejected");
  const excessiveSize = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", body: { case_id: ids.caseA, title: "Excessive size", size_bytes: 26214401 }
  });
  assert.equal(excessiveSize.status, 400, "metadata size above 25 MiB must be rejected");
  const rejectedAudit = await pool.query("select count(*)::int as count from audit_logs where action='create' and entity_type='case_document'");
  assert.equal(rejectedAudit.rows[0].count, 0, "rejected writes must not create audit records");

  const oversizedBody = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Oversized request", description: "x".repeat(110000) }
  });
  assert.equal(oversizedBody.status, 413, "oversized JSON request must receive 413");
  assert.deepEqual(oversizedBody.body, { error: "request_too_large" }, "oversized request response must not disclose parser internals");
  const created = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Confidential Office A document", document_type: "evidence" }
  });
  assert.equal(created.status, 201, `office A create failed: ${JSON.stringify(created.body)}`);
  const documentId = created.body.data.id;

  const filteredOwn = await request("/api/case-documents?case_id=" + ids.caseA, { token: tokenA, csrf: csrfA });
  assert.equal(filteredOwn.status, 200, "valid case_id filter must work");
  assert.equal(filteredOwn.body.data.length, 1, "case_id filter must return only matching case documents");
  const filteredOther = await request("/api/case-documents?case_id=" + ids.caseB, { token: tokenA, csrf: csrfA });
  assert.equal(filteredOther.status, 200);
  assert.equal(filteredOther.body.data.length, 0, "case_id filter must not return documents from another case");

  const ownDetail = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA });
  assert.equal(ownDetail.status, 200, "office A must be able to view its own document");

  const otherList = await request("/api/case-documents", { token: tokenB, csrf: csrfB });
  assert.equal(otherList.status, 200);
  assert.equal(otherList.body.data.some(item => item.id === documentId), false, "office B list must not reveal office A document");

  const crossRead = await request(`/api/case-documents/${documentId}`, { token: tokenB, csrf: csrfB });
  assert.equal(crossRead.status, 404, "cross-office read must return not found");

  const crossUpdate = await request(`/api/case-documents/${documentId}`, {
    token: tokenB, csrf: csrfB, method: "PATCH", body: { title: "Tampered by Office B" }
  });
  assert.equal(crossUpdate.status, 404, "cross-office update must return not found");

  const crossDelete = await request(`/api/case-documents/${documentId}`, {
    token: tokenB, csrf: csrfB, method: "DELETE"
  });
  assert.equal(crossDelete.status, 404, "cross-office delete must return not found");

  const persisted = await pool.query("select title, deleted_at from case_documents where id=$1", [documentId]);
  assert.equal(persisted.rows[0].title, "Confidential Office A document", "cross-office update must not mutate the document");
  assert.equal(persisted.rows[0].deleted_at, null, "cross-office delete must not soft-delete the document");

  const createAudit = await pool.query("select action, entity_id from audit_logs where entity_type='case_document' and entity_id=$1", [documentId]);
  assert.equal(createAudit.rows.filter(row => row.action === "create").length, 1, "successful create must be audited once");

  const idempotentPayload = { case_id: ids.caseA, title: "Idempotent retry regression", document_type: "evidence" };
  const idempotentFirst = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", idempotencyKey: "retry-key-12345678", body: idempotentPayload
  });
  assert.equal(idempotentFirst.status, 201, "first idempotent create should create the document");
  const idempotentReplay = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", idempotencyKey: "retry-key-12345678", body: idempotentPayload
  });
  assert.equal(idempotentReplay.status, 200, "retry with same key and payload should return prior result");
  assert.equal(idempotentReplay.body.data.id, idempotentFirst.body.data.id, "retry must not create a second document");
  assert.equal(idempotentReplay.body.idempotent_replay, true);
  const idempotentAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='create'", [idempotentFirst.body.data.id]);
  assert.equal(idempotentAudit.rows[0].count, 1, "idempotent retry must not duplicate audit records");
  const keyReuse = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", idempotencyKey: "retry-key-12345678",
    body: { ...idempotentPayload, title: "Different payload under same key" }
  });
  assert.equal(keyReuse.status, 409, "same idempotency key with different payload must be rejected");
  assert.deepEqual(keyReuse.body, { error: "idempotency_key_reused" });
  const invalidKey = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", idempotencyKey: "bad key",
    body: idempotentPayload
  });
  assert.equal(invalidKey.status, 400, "malformed idempotency keys must be rejected");


  await pool.query(`
    create or replace function reject_document_mutation_audit() returns trigger language plpgsql as $fn$
    begin
      if new.entity_type = 'case_document' and new.action in ('create','update','delete') then
        raise exception 'forced audit failure for rollback test';
      end if;
      return new;
    end;
    $fn$;
    create trigger reject_document_mutation_audit_trigger
      before insert on audit_logs for each row execute function reject_document_mutation_audit();
  `);
  const createAuditBeforeFailure = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and action='create'");
  const failedCreate = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Create must roll back with audit" }
  });
  assert.equal(failedCreate.status, 500, "audit failure must reject document creation");
  assert.deepEqual(failedCreate.body, { error: "database_error" }, "create audit failure response must be sanitized");
  const failedCreateRow = await pool.query("select count(*)::int as count from case_documents where title='Create must roll back with audit'");
  assert.equal(failedCreateRow.rows[0].count, 0, "failed create must roll back the document row");
  const failedCreateAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and action='create'");
  assert.equal(failedCreateAudit.rows[0].count, createAuditBeforeFailure.rows[0].count, "failed create must not leave an audit row");

  const failedUpdate = await request(`/api/case-documents/${documentId}`, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { title: "Must Roll Back" }
  });
  assert.equal(failedUpdate.status, 500, "audit insert failure should return a generic server error");
  assert.deepEqual(failedUpdate.body, { error: "database_error" }, "unexpected database errors must not disclose internal exception text");
  assert.equal(JSON.stringify(failedUpdate.body).includes("forced audit failure"), false, "database exception details must stay out of HTTP responses");
  const afterFailedUpdate = await pool.query("select title from case_documents where id=$1", [documentId]);
  assert.equal(afterFailedUpdate.rows[0].title, "Confidential Office A document", "document update must roll back when audit insert fails");
  const failedUpdateAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [documentId]);
  assert.equal(failedUpdateAudit.rows[0].count, 0, "failed update must not leave an audit row");
  await pool.query("drop trigger reject_document_mutation_audit_trigger on audit_logs");
  const ownUpdate = await request(`/api/case-documents/${documentId}`, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { title: "Updated by Office A" }
  });
  assert.equal(ownUpdate.status, 200, "office A can update its own document");
  assert.equal(ownUpdate.body.data.document_type, "evidence", "title-only patch must not silently reset document type to the create default");
  const updateAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [documentId]);
  assert.equal(updateAudit.rows[0].count, 1, "successful update must be audited once");
  await pool.query(`
    create trigger reject_document_mutation_audit_trigger
      before insert on audit_logs for each row execute function reject_document_mutation_audit();
  `);
  const failedDelete = await request(`/api/case-documents/${documentId}`, {
    token: tokenA, csrf: csrfA, method: "DELETE"
  });
  assert.equal(failedDelete.status, 500, "audit insert failure should prevent delete");
  const afterFailedDelete = await pool.query("select deleted_at from case_documents where id=$1", [documentId]);
  assert.equal(afterFailedDelete.rows[0].deleted_at, null, "soft delete must roll back when audit insert fails");
  const failedDeleteAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'", [documentId]);
  assert.equal(failedDeleteAudit.rows[0].count, 0, "failed delete must not leave an audit row");
  await pool.query("drop trigger reject_document_mutation_audit_trigger on audit_logs");
  await pool.query("drop function reject_document_mutation_audit()");

  const softDelete = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA, method: "DELETE" });
  assert.equal(softDelete.status, 204, "own document should soft-delete successfully");
  const hiddenDetail = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA });
  assert.equal(hiddenDetail.status, 404, "soft-deleted document must be hidden from detail API");
  const hiddenList = await request("/api/case-documents", { token: tokenA, csrf: csrfA });
  assert.equal(hiddenList.body.data.some(item => item.id === documentId), false, "soft-deleted document must be hidden from list API");
  const deleteAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'", [documentId]);
  assert.equal(deleteAudit.rows[0].count, 1, "successful soft delete must be audited once");
  const repeatedDelete = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA, method: "DELETE" });
  assert.equal(repeatedDelete.status, 404, "repeated soft delete must return not found");
  const repeatDeleteAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'", [documentId]);
  assert.equal(repeatDeleteAudit.rows[0].count, 1, "repeated delete must not create duplicate audit events");
  
  const raceCreated = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Concurrent mutation regression" }
  });
  assert.equal(raceCreated.status, 201, "race-test document should be created");
  const raceId = raceCreated.body.data.id;
  const raceResults = await Promise.all([
    request(`/api/case-documents/${raceId}`, { token: tokenA, csrf: csrfA, method: "PATCH", body: { title: "Concurrent update" } }),
    request(`/api/case-documents/${raceId}`, { token: tokenA, csrf: csrfA, method: "DELETE" }),
    request(`/api/case-documents/${raceId}`, { token: tokenA, csrf: csrfA, method: "DELETE" })
  ]);
  assert.ok([200, 404].includes(raceResults[0].status), "concurrent update should either commit before deletion or see the deleted row");
  assert.deepEqual(raceResults.slice(1).map(result => result.status).sort((a,b) => a-b), [204, 404], "exactly one concurrent delete may succeed");
  const raceAudit = await pool.query("select action, count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 group by action", [raceId]);
  const raceAuditCounts = Object.fromEntries(raceAudit.rows.map(row => [row.action, row.count]));
  assert.equal(raceAuditCounts.delete, 1, "concurrent delete requests must create exactly one delete audit row");
  assert.equal(raceAuditCounts.update || 0, raceResults[0].status === 200 ? 1 : 0, "update audit must match whether the update committed");
  const racePersisted = await pool.query("select deleted_at from case_documents where id=$1", [raceId]);
  assert.ok(racePersisted.rows[0].deleted_at, "concurrent mutation race must end in a soft-deleted state");

  const timeoutCreated = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Database statement timeout regression" }
  });
  assert.equal(timeoutCreated.status, 201, "timeout-test document should be created");
  const timeoutId = timeoutCreated.body.data.id;
  await pool.query(`
    create or replace function delay_target_document_update() returns trigger language plpgsql as $fn$
    begin
      if new.id = '${timeoutId}'::uuid then
        perform pg_sleep(1);
      end if;
      return new;
    end;
    $fn$;
    create trigger delay_target_document_update_trigger
      before update on case_documents for each row execute function delay_target_document_update();
  `);
  const timeoutPort = port + 2;
  timeoutServer = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(timeoutPort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin, DB_STATEMENT_TIMEOUT_MS: "250" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  timeoutServer.stdout.on("data", chunk => { timeoutServerOutput += chunk.toString(); });
  timeoutServer.stderr.on("data", chunk => { timeoutServerOutput += chunk.toString(); });
  await waitForServer(timeoutPort);
  const timeoutResponse = await fetch(`http://127.0.0.1:${timeoutPort}/api/case-documents/${timeoutId}`, {
    method: "PATCH",
    headers: { origin, cookie: `dadban_session=${tokenA}; dadban_csrf=${csrfA}`, "x-csrf-token": csrfA, "content-type": "application/json" },
    body: JSON.stringify({ title: "This update must time out" })
  });
  assert.equal(timeoutResponse.status, 500, "database statement timeout must fail the request without hanging");
  const timeoutBody = await timeoutResponse.json();
  assert.deepEqual(timeoutBody, { error: "database_error" }, "statement timeout response must be sanitized");
  assert.equal(JSON.stringify(timeoutBody).includes("statement timeout"), false, "statement timeout details must not be disclosed");
  const afterTimeout = await pool.query("select title from case_documents where id=$1", [timeoutId]);
  assert.equal(afterTimeout.rows[0].title, "Database statement timeout regression", "timed-out update must roll back");
  const timeoutAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [timeoutId]);
  assert.equal(timeoutAudit.rows[0].count, 0, "timed-out update must not leave an audit record");
  await pool.query("drop trigger delay_target_document_update_trigger on case_documents");
  await pool.query("drop function delay_target_document_update()");
  timeoutServer.kill("SIGTERM");
  timeoutServer = null;



  console.log("PASS: office A can read its own document");
  console.log("PASS: office B list does not disclose office A document");
  console.log("PASS: case_id filters work without SQL errors");
  console.log("PASS: untrusted Origin, missing CSRF, and impossible date are rejected");
  console.log("PASS: successful create/update are audited once");
  console.log("PASS: audit failures roll back update and soft delete");
  console.log("PASS: soft-deleted document is hidden and audited once");
  console.log("PASS: title and size boundary inputs are rejected");
  console.log("PASS: database connection outage returns sanitized 503");
  console.log("PASS: oversized JSON receives a sanitized 413 response");
  console.log("PASS: repeated soft delete does not duplicate audit events");
  console.log("PASS: concurrent update/delete requests remain consistent with exactly one delete audit");
  console.log("PASS: database statement timeout rolls back mutation and returns sanitized error");
  assert.equal(serverOutput.includes("forced audit failure"), false, "server logs must not include raw database exception messages");
  assert.equal(serverOutput.includes("statement timeout"), false, "server logs must not include raw statement timeout details");
  assert.equal(timeoutServerOutput.includes("statement timeout"), false, "timeout-server logs must not disclose raw database errors");
  console.log("PASS: authentication and CSRF negatives are rejected with generic responses");
  console.log("PASS: server logs omit raw database exception details");
  console.log("PASS: cross-office read rejected");
  console.log("PASS: cross-office update rejected without mutation");
  console.log("PASS: cross-office delete rejected without mutation");

  let rateLimited = false;
  for (let i = 0; i < 21; i++) {
    const limited = await request("/api/case-documents", {
      token: tokenA, csrf: csrfA, method: "POST",
      idempotencyKey: `rate-limit-key-${String(i).padStart(2,"0")}`,
      body: { case_id: ids.caseA, title: `Rate limit test ${i}` }
    });
    if (limited.status === 429) {
      rateLimited = true;
      assert.deepEqual(limited.body, { error: "rate_limit_exceeded" });
      assert.ok(Number(limited.headers?.["retry-after"] || 1) >= 1);
    }
  }
  assert.equal(rateLimited, true, "document create requests must be rate-limited");
  console.log("PASS: idempotency retries do not duplicate documents or audit rows");
  console.log("PASS: document create rate limit returns sanitized 429");

  const expiredSession = await pool.query("update auth_sessions set expires_at=now()-interval '1 minute' where token_hash=$1", [hash(tokenA)]);
  assert.equal(expiredSession.rowCount, 1, "test fixture session should exist before expiry test");
  const expiredRequest = await request("/api/case-documents", { token: tokenA, csrf: csrfA });
  assert.equal(expiredRequest.status, 401, "expired session must no longer authorize API access");
  assert.deepEqual(expiredRequest.body, { error: "authentication_required" });
  console.log("PASS: expired session is rejected");

} catch (error) {
  console.error(error);
  if (server) console.error(serverOutput);
  if (outageServer) console.error(outageServerOutput);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (outageServer && outageServer.exitCode === null) outageServer.kill("SIGTERM");
  if (timeoutServer && timeoutServer.exitCode === null) timeoutServer.kill("SIGTERM");
  await pool.end();
}
