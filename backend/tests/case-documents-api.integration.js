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
let auditServer;
let auditServerOutput = "";
let outageServer;
let outageServerOutput = "";
let timeoutServer;
let timeoutServerOutput = "";
let rateLimitServer;
let rateLimitServerOutput = "";
let roleServer;
let roleServerOutput = "";
let retryServer;
let retryServerOutput = "";
let crashServer;
let crashServerOutput = "";

const ids = {
  officeA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  officeB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  userB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
  userAdmin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11",
  userLawyer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12",
  userAssistant: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa13",
  userViewer: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa14",
  caseA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
  caseB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02"
};
const tokenA = "test-session-office-a-".padEnd(48, "a");
const tokenB = "test-session-office-b-".padEnd(48, "b");
const csrfA = "test-csrf-office-a-".padEnd(48, "c");
const csrfB = "test-csrf-office-b-".padEnd(48, "d");
const roleAccounts = [
  { role: "owner", id: ids.userA, token: tokenA, csrf: csrfA },
  { role: "admin", id: ids.userAdmin, token: "test-session-role-admin-".padEnd(48, "e"), csrf: "test-csrf-role-admin-".padEnd(48, "f") },
  { role: "lawyer", id: ids.userLawyer, token: "test-session-role-lawyer-".padEnd(48, "g"), csrf: "test-csrf-role-lawyer-".padEnd(48, "h") },
  { role: "assistant", id: ids.userAssistant, token: "test-session-role-assistant-".padEnd(48, "i"), csrf: "test-csrf-role-assistant-".padEnd(48, "j") },
  { role: "viewer", id: ids.userViewer, token: "test-session-role-viewer-".padEnd(48, "k"), csrf: "test-csrf-role-viewer-".padEnd(48, "l") }
];
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

async function request(path, { token, csrf, method = "GET", body, originHeader = origin, csrfHeader = true, idempotencyKey, extraHeaders = {}, portToUse = port, hostToUse = "127.0.0.1" } = {}) {
  const headers = { origin: originHeader, cookie: `dadban_session=${token}; dadban_csrf=${csrf}`, ...extraHeaders };
  if (csrfHeader && ["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    headers["x-csrf-token"] = csrf;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`http://${hostToUse}:${portToUse}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: { "retry-after": response.headers.get("retry-after"), "set-cookie": response.headers.get("set-cookie") } };
}

try {
  // This script is only permitted to reset its dedicated, disposable localhost test DB.
  await pool.query(`
    drop function if exists public.lock_live_document_actor(uuid,uuid,uuid) cascade;
    drop function if exists public.lock_live_client_parent(uuid,uuid) cascade;
    drop function if exists public.lock_live_case_client(uuid,uuid) cascade;
    drop function if exists public.lock_live_case_parents(uuid,uuid[]) cascade;
    drop function if exists public.lock_live_case_reassignment(uuid,uuid,uuid) cascade;
    drop function if exists public.prevent_case_document_idempotency_delete() cascade;
    drop function if exists public.prevent_case_document_idempotency_reopen() cascade;
    drop table if exists case_document_mutation_idempotency cascade;
    drop table if exists case_documents cascade;
    drop table if exists audit_logs cascade;
    drop table if exists auth_sessions cascade;
    drop table if exists auth_credentials cascade;
    drop table if exists hearings cascade;
    drop table if exists case_actions cascade;
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
    create table clients (
      id uuid primary key default gen_random_uuid(), office_id uuid not null references offices(id),
      client_type text not null default 'individual', full_name text not null,
      national_id text, birth_date date, occupation text, company_name text,
      national_company_id text, registration_no text, mobile text, phone text,
      email text, source text, address text, notes text,
      status text not null default 'active', created_by uuid, updated_by uuid,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
      unique (id, office_id)
    );
    create table cases (
      id uuid primary key default gen_random_uuid(), office_id uuid not null references offices(id),
      client_id uuid not null, case_number text not null, title text not null,
      case_type text, court_name text, branch_name text, opposing_party text,
      status text not null default 'active', priority text, filing_date date,
      next_hearing_at timestamptz, description text, notes text, created_by uuid, updated_by uuid,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      deleted_at timestamptz, unique (id, office_id),
      constraint cases_client_same_office_fk foreign key (client_id, office_id)
        references clients(id, office_id) on delete restrict
    );
    create table hearings (
      id uuid primary key default gen_random_uuid(), office_id uuid not null references offices(id),
      case_id uuid not null, hearing_at timestamptz not null, hearing_type text,
      court_name text, branch_name text, status text not null default 'scheduled',
      reminder_minutes integer, notes text, created_by uuid, updated_by uuid, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), deleted_at timestamptz,
      constraint hearings_case_same_office_fk foreign key (case_id, office_id)
        references cases(id, office_id) on delete restrict
    );
    create table case_actions (
      id uuid primary key default gen_random_uuid(), office_id uuid not null references offices(id),
      case_id uuid not null, title text not null, description text, due_at timestamptz,
      status text not null default 'todo', priority text, assigned_to uuid,
      completed_at timestamptz, created_by uuid, updated_by uuid, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), deleted_at timestamptz,
      constraint case_actions_case_same_office_fk foreign key (case_id, office_id)
        references cases(id, office_id) on delete restrict
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
  const mutationIdempotencyMigration = await readFile(new URL("../migrations/006_case_document_mutation_idempotency.sql", import.meta.url), "utf8");
  await pool.query(mutationIdempotencyMigration);
  const mutationTombstoneMigration = await readFile(new URL("../migrations/007_case_document_mutation_tombstones.sql", import.meta.url), "utf8");
  await pool.query(mutationTombstoneMigration);
  const actorLockMigration = await readFile(new URL("../migrations/008_security_definer_document_actor_lock.sql", import.meta.url), "utf8");
  await pool.query(actorLockMigration);
  const caseReassignmentLockMigration = await readFile(new URL("../migrations/009_case_reassignment_parent_locks.sql", import.meta.url), "utf8");
  await pool.query(caseReassignmentLockMigration);
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
  await pool.query(`
    insert into users(id,office_id,full_name,email,role) values
      ($1,$2,'Test Owner','owner@example.test','owner'),
      ($3,$4,'Test User B','b@example.test','owner'),
      ($5,$6,'Test Admin','admin@example.test','admin'),
      ($7,$8,'Test Lawyer','lawyer@example.test','lawyer'),
      ($9,$10,'Test Assistant','assistant@example.test','assistant'),
      ($11,$12,'Test Viewer','viewer@example.test','viewer')
  `, [ids.userA,ids.officeA,ids.userB,ids.officeB,ids.userAdmin,ids.officeA,ids.userLawyer,ids.officeA,ids.userAssistant,ids.officeA,ids.userViewer,ids.officeA]);
   const clientA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa21";
   const clientB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb21";
   const hearingA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22";
   const hearingB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb22";
   const actionA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa23";
   const actionB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb23";
   await pool.query("insert into clients(id,office_id,full_name,national_id) values ($1,$2,'Client A','1234567890'),($3,$4,'Client B','0987654321')",
     [clientA,ids.officeA,clientB,ids.officeB]);
   await pool.query("insert into cases(id,office_id,client_id,case_number,title) values ($1,$2,$3,'A-001','Case A'),($4,$5,$6,'B-001','Case B')",
     [ids.caseA,ids.officeA,clientA,ids.caseB,ids.officeB,clientB]);
   await pool.query("insert into hearings(id,office_id,case_id,hearing_at,hearing_type) values ($1,$2,$3,now()+interval '1 day','trial'),($4,$5,$6,now()+interval '2 days','trial')",
     [hearingA,ids.officeA,ids.caseA,hearingB,ids.officeB,ids.caseB]);
   await pool.query("insert into case_actions(id,office_id,case_id,title,assigned_to) values ($1,$2,$3,'Action A',$4),($5,$6,$7,'Action B',$8)",
     [actionA,ids.officeA,ids.caseA,ids.userA,actionB,ids.officeB,ids.caseB,ids.userB]);
  const sessionValues = [
    ids.userA, ids.officeA, hash(tokenA), hash(csrfA),
    ids.userB, ids.officeB, hash(tokenB), hash(csrfB),
    ...roleAccounts.slice(1).flatMap(account => [account.id, ids.officeA, hash(account.token), hash(account.csrf)])
  ];
  await pool.query(`
    insert into auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) values
      ($1,$2,$3,$4,now()+interval '1 hour'),
      ($5,$6,$7,$8,now()+interval '1 hour'),
      ($9,$10,$11,$12,now()+interval '1 hour'),
      ($13,$14,$15,$16,now()+interval '1 hour'),
      ($17,$18,$19,$20,now()+interval '1 hour'),
      ($21,$22,$23,$24,now()+interval '1 hour')
  `, sessionValues);

  const expiredToken = "test-session-expired-document".padEnd(48, "m");
  const revokedToken = "test-session-revoked-document".padEnd(48, "n");
  await pool.query(`
    insert into auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at,revoked_at) values
      ($1,$2,$3,$4,now()-interval '1 minute',null),
      ($1,$2,$5,$4,now()+interval '1 hour',now())
  `, [ids.userA,ids.officeA,hash(expiredToken),hash(csrfA),hash(revokedToken)]);

  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin, DB_LOCK_TIMEOUT_MS: "20000" },
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
  const outageAuthenticatedRequest = await fetch(`http://127.0.0.1:${outagePort}/api/case-documents`, {
    headers: { cookie: `dadban_session=${tokenA}; dadban_csrf=${csrfA}` },
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(outageAuthenticatedRequest.status, 401, "database connection failure during authentication must fail closed");
  assert.deepEqual(await outageAuthenticatedRequest.json(), { error: "authentication_required" },
    "authentication connection errors must return a sanitized response");
  outageServer.kill("SIGTERM");
  outageServer = null;

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/case-documents`);
  assert.equal(unauthenticated.status, 401, "document listing must require a valid session");
  assert.deepEqual(await unauthenticated.json(), { error: "authentication_required" }, "unauthenticated response must remain generic");

  for (const [label, token] of [["expired", expiredToken], ["revoked", revokedToken]]) {
    const expiredList = await request("/api/case-documents", { token, csrf: csrfA });
    assert.equal(expiredList.status, 401, `${label} session must not read document metadata`);
    assert.deepEqual(expiredList.body, { error: "authentication_required" });
    const expiredDetail = await request("/api/case-documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99", { token, csrf: csrfA });
    assert.equal(expiredDetail.status, 401, `${label} session must not read document detail metadata`);
    assert.deepEqual(expiredDetail.body, { error: "authentication_required" });
  }
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
  for (const forbiddenField of [
    { storage_key: "private/path.pdf" },
    { storage_status: "stored" },
    { file_data: "AAECAw==" },
    { upload_url: "https://example.invalid/upload" },
    { file: "binary-placeholder" }
  ]) {
    const forbidden = await request("/api/case-documents", {
      token: tokenA, csrf: csrfA, method: "POST",
      body: { case_id: ids.caseA, title: "Reject storage fields", ...forbiddenField }
    });
    assert.equal(forbidden.status, 400, "storage/upload fields must be rejected in metadata-only phase");
  }
  const pathLikeFilename = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Reject path-like filename", original_filename: "../../private.pdf" }
  });
  assert.equal(pathLikeFilename.status, 400, "filename metadata must reject path separators");

  const windowsPathFilename = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Reject Windows path filename", original_filename: "C:\\private.pdf" }
  });
  assert.equal(windowsPathFilename.status, 400, "filename metadata must reject Windows path separators");

  const controlCharacterFilename = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Reject control character filename", original_filename: "bad\u0000name.pdf" }
  });
  assert.equal(controlCharacterFilename.status, 400, "filename metadata must reject control characters");

  const pathLikeFilenameUpdate = await request("/api/case-documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03", {
    token: tokenA, csrf: csrfA, method: "PATCH",
    body: { original_filename: "../private.pdf" }
  });
  assert.equal(pathLikeFilenameUpdate.status, 400, "filename metadata must reject path separators on update too");
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
  const auditUserAgent = "Dadban-Audit-Test/1.0";
  const created = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    extraHeaders: { "user-agent": auditUserAgent, "x-forwarded-for": "203.0.113.77" },
    body: { case_id: ids.caseA, title: "Confidential Office A document", document_type: "evidence", confidentiality: "restricted" }
  });
  assert.equal(created.status, 201, `office A create failed: ${JSON.stringify(created.body)}`);
  assert.equal(created.body.data.confidentiality, "restricted", "API must persist and return requested confidentiality");
  const documentId = created.body.data.id;
  const requestAudit = await pool.query(
    "select ip_address, user_agent from audit_logs where entity_type='case_document' and entity_id=$1 and action='create'",
    [documentId]
  );
  assert.equal(requestAudit.rowCount, 1, "successful create should emit one request-attributed audit event");
  assert.ok(["127.0.0.1", "::ffff:127.0.0.1"].includes(requestAudit.rows[0].ip_address),
    "audit IP must use the socket peer and ignore untrusted X-Forwarded-For");
  assert.notEqual(requestAudit.rows[0].ip_address, "203.0.113.77",
    "untrusted forwarded IP must not override the direct peer");
  assert.equal(requestAudit.rows[0].user_agent, auditUserAgent, "audit must capture the request User-Agent");

  const filteredOwn = await request("/api/case-documents?case_id=" + ids.caseA, { token: tokenA, csrf: csrfA });
  assert.equal(filteredOwn.status, 200, "valid case_id filter must work");
  assert.equal(filteredOwn.body.data.length, 1, "case_id filter must return only matching case documents");
  const filteredOther = await request("/api/case-documents?case_id=" + ids.caseB, { token: tokenA, csrf: csrfA });
  assert.equal(filteredOther.status, 200);
  assert.equal(filteredOther.body.data.length, 0, "case_id filter must not return documents from another case");

  const ownDetail = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA });
  assert.equal(ownDetail.status, 200, "office A must be able to view its own document");
  assert.equal(ownDetail.body.data.confidentiality, "restricted", "detail endpoint must return persisted confidentiality");

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

  // Cross-office HTTP isolation for the other resource families. Existing document isolation
  // assertions above remain the dedicated case-document coverage; this fills the missing routes.
  const clientsA = await request("/api/clients", { token: tokenA, csrf: csrfA });
  const clientsB = await request("/api/clients", { token: tokenB, csrf: csrfB });
  assert.equal(clientsA.status, 200);
  assert.ok(clientsA.body.data.some(row => row.id === clientA), "office A client list must include its own client");
  assert.equal(clientsA.body.data.some(row => row.id === clientB), false, "office A client list must hide office B clients");
  assert.equal(clientsB.status, 200);
  assert.ok(clientsB.body.data.some(row => row.id === clientB), "office B client list must include its own client");
  assert.equal(clientsB.body.data.some(row => row.id === clientA), false, "office B client list must hide office A clients");
  assert.equal((await request("/api/clients/" + clientA, { token: tokenA, csrf: csrfA })).status, 200);
  assert.equal((await request("/api/clients/" + clientA, { token: tokenB, csrf: csrfB })).status, 404,
    "cross-office client detail must be indistinguishable from a missing client");
  assert.equal((await request("/api/clients/lookup?national_id=1234567890", { token: tokenB, csrf: csrfB })).status, 404,
    "client lookup must not reveal another office's national ID");

  const casesA = await request("/api/cases", { token: tokenA, csrf: csrfA });
  const casesB = await request("/api/cases", { token: tokenB, csrf: csrfB });
  assert.equal(casesA.status, 200);
  assert.ok(casesA.body.data.some(row => row.id === ids.caseA), "office A case list must include its own case");
  assert.equal(casesA.body.data.some(row => row.id === ids.caseB), false, "office A case list must hide office B cases");
  assert.equal(casesB.status, 200);
  assert.ok(casesB.body.data.some(row => row.id === ids.caseB), "office B case list must include its own case");
  assert.equal(casesB.body.data.some(row => row.id === ids.caseA), false, "office B case list must hide office A cases");
  assert.equal((await request("/api/cases/" + ids.caseA, { token: tokenA, csrf: csrfA })).status, 200);
  assert.equal((await request("/api/cases/" + ids.caseA, { token: tokenB, csrf: csrfB })).status, 404,
    "cross-office case detail must return not found");

  const hearingsA = await request("/api/hearings", { token: tokenA, csrf: csrfA });
  const hearingsB = await request("/api/hearings", { token: tokenB, csrf: csrfB });
  assert.equal(hearingsA.status, 200);
  assert.ok(hearingsA.body.data.some(row => row.id === hearingA), "office A hearing list must include its own hearing");
  assert.equal(hearingsA.body.data.some(row => row.id === hearingB), false, "office A hearing list must hide office B hearings");
  assert.equal(hearingsB.status, 200);
  assert.ok(hearingsB.body.data.some(row => row.id === hearingB), "office B hearing list must include its own hearing");
  assert.equal(hearingsB.body.data.some(row => row.id === hearingA), false, "office B hearing list must hide office A hearings");
  assert.equal((await request("/api/hearings/" + hearingA, { token: tokenA, csrf: csrfA })).status, 200);
  assert.equal((await request("/api/hearings/" + hearingA, { token: tokenB, csrf: csrfB })).status, 404,
    "cross-office hearing detail must return not found");

  const actionsA = await request("/api/actions", { token: tokenA, csrf: csrfA });
  const actionsB = await request("/api/actions", { token: tokenB, csrf: csrfB });
  assert.equal(actionsA.status, 200);
  assert.ok(actionsA.body.data.some(row => row.id === actionA), "office A action list must include its own action");
  assert.equal(actionsA.body.data.some(row => row.id === actionB), false, "office A action list must hide office B actions");
  assert.equal(actionsB.status, 200);
  assert.ok(actionsB.body.data.some(row => row.id === actionB), "office B action list must include its own action");
  assert.equal(actionsB.body.data.some(row => row.id === actionA), false, "office B action list must hide office A actions");
  assert.equal((await request("/api/actions/" + actionA, { token: tokenA, csrf: csrfA })).status, 200);
  assert.equal((await request("/api/actions/" + actionA, { token: tokenB, csrf: csrfB })).status, 404,
    "cross-office action detail must return not found");

  const assigneesA = await request("/api/actions/assignees", { token: tokenA, csrf: csrfA });
  const assigneesB = await request("/api/actions/assignees", { token: tokenB, csrf: csrfB });
  assert.equal(assigneesA.status, 200);
  assert.ok(assigneesA.body.data.some(row => row.id === ids.userA), "office A assignee list must include its own user");
  assert.equal(assigneesA.body.data.some(row => row.id === ids.userB), false, "office A assignee list must hide office B users");
  assert.equal(assigneesB.status, 200);
  assert.ok(assigneesB.body.data.some(row => row.id === ids.userB), "office B assignee list must include its own user");
  assert.equal(assigneesB.body.data.some(row => row.id === ids.userA), false, "office B assignee list must hide office A users");

  // Write-path isolation is distinct from the read/list coverage above. Exercise the
  // real HTTP handlers and assert both rejection status and persisted state.
  const forgedClientCreate = await request("/api/clients", {
    token: tokenB, csrf: csrfB, method: "POST",
    body: { client_type: "individual", full_name: "Office B Created Client", national_id: "1122334455", office_id: ids.officeA }
  });
  assert.equal(forgedClientCreate.status, 201, "client creation should derive tenant from authenticated session");
  assert.equal(forgedClientCreate.body.data.office_id, ids.officeB, "client payload must not override authenticated office");
  const clientCrossPatch = await request("/api/clients/" + clientA, {
    token: tokenB, csrf: csrfB, method: "PATCH", body: { full_name: "Cross-office tamper" }
  });
  assert.equal(clientCrossPatch.status, 404, "cross-office client update must return not found");
  const clientCrossDelete = await request("/api/clients/" + clientA, {
    token: tokenB, csrf: csrfB, method: "DELETE"
  });
  assert.equal(clientCrossDelete.status, 404, "cross-office client delete must return not found");
  const clientAfterWriteAttempts = await pool.query("select full_name, deleted_at from clients where id=$1", [clientA]);
  assert.equal(clientAfterWriteAttempts.rows[0].full_name, "Client A", "cross-office client update must not mutate data");
  assert.equal(clientAfterWriteAttempts.rows[0].deleted_at, null, "cross-office client delete must not soft-delete data");

  const caseForeignClientCreate = await request("/api/cases", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { client_id: clientB, case_number: "A-FOREIGN", title: "Foreign client case" }
  });
  assert.equal(caseForeignClientCreate.status, 400, "case creation must reject a client from another office");
  const caseForeignClientPatch = await request("/api/cases/" + ids.caseA, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { client_id: clientB }
  });
  assert.equal(caseForeignClientPatch.status, 400, "case update must reject reassignment to another office's client");
  const caseCrossPatch = await request("/api/cases/" + ids.caseA, {
    token: tokenB, csrf: csrfB, method: "PATCH", body: { title: "Cross-office tamper" }
  });
  assert.equal(caseCrossPatch.status, 404, "cross-office case update must return not found");
  const caseCrossDelete = await request("/api/cases/" + ids.caseA, {
    token: tokenB, csrf: csrfB, method: "DELETE"
  });
  assert.equal(caseCrossDelete.status, 404, "cross-office case delete must return not found");
  const caseAfterWriteAttempts = await pool.query("select title, client_id, deleted_at from cases where id=$1", [ids.caseA]);
  assert.equal(caseAfterWriteAttempts.rows[0].title, "Case A", "cross-office case update must not mutate data");
  assert.equal(caseAfterWriteAttempts.rows[0].client_id, clientA, "invalid client reassignment must not change the case link");
  assert.equal(caseAfterWriteAttempts.rows[0].deleted_at, null, "cross-office case delete must not soft-delete data");

  const hearingForeignCaseCreate = await request("/api/hearings", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseB, hearing_at: new Date(Date.now() + 86400000).toISOString(), hearing_type: "trial" }
  });
  assert.equal(hearingForeignCaseCreate.status, 400, "hearing creation must reject a case from another office");
  const hearingForeignCasePatch = await request("/api/hearings/" + hearingA, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { case_id: ids.caseB }
  });
  assert.equal(hearingForeignCasePatch.status, 400, "hearing update must reject reassignment to another office's case");
  const hearingCrossPatch = await request("/api/hearings/" + hearingA, {
    token: tokenB, csrf: csrfB, method: "PATCH", body: { notes: "Cross-office tamper" }
  });
  assert.equal(hearingCrossPatch.status, 404, "cross-office hearing update must return not found");
  const hearingCrossDelete = await request("/api/hearings/" + hearingA, {
    token: tokenB, csrf: csrfB, method: "DELETE"
  });
  assert.equal(hearingCrossDelete.status, 404, "cross-office hearing delete must return not found");
  const hearingAfterWriteAttempts = await pool.query("select case_id, notes, deleted_at from hearings where id=$1", [hearingA]);
  assert.equal(hearingAfterWriteAttempts.rows[0].case_id, ids.caseA, "invalid hearing reassignment must not change its case link");
  assert.equal(hearingAfterWriteAttempts.rows[0].notes, null, "cross-office hearing update must not mutate data");
  assert.equal(hearingAfterWriteAttempts.rows[0].deleted_at, null, "cross-office hearing delete must not soft-delete data");

  const actionForeignCaseCreate = await request("/api/actions", {
    token: tokenA, csrf: csrfA, method: "POST", body: { case_id: ids.caseB, title: "Foreign case action" }
  });
  assert.equal(actionForeignCaseCreate.status, 400, "action creation must reject a case from another office");
  const actionForeignAssigneeCreate = await request("/api/actions", {
    token: tokenA, csrf: csrfA, method: "POST", body: { case_id: ids.caseA, title: "Foreign assignee action", assigned_to: ids.userB }
  });
  assert.equal(actionForeignAssigneeCreate.status, 400, "action creation must reject an assignee from another office");
  const actionForeignCasePatch = await request("/api/actions/" + actionA, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { case_id: ids.caseB }
  });
  assert.equal(actionForeignCasePatch.status, 400, "action update must reject reassignment to another office's case");
  const actionForeignAssigneePatch = await request("/api/actions/" + actionA, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { assigned_to: ids.userB }
  });
  assert.equal(actionForeignAssigneePatch.status, 400, "action update must reject an assignee from another office");
  const actionCrossPatch = await request("/api/actions/" + actionA, {
    token: tokenB, csrf: csrfB, method: "PATCH", body: { title: "Cross-office tamper" }
  });
  assert.equal(actionCrossPatch.status, 404, "cross-office action update must return not found");
  const actionCrossDelete = await request("/api/actions/" + actionA, {
    token: tokenB, csrf: csrfB, method: "DELETE"
  });
  assert.equal(actionCrossDelete.status, 404, "cross-office action delete must return not found");
  const actionAfterWriteAttempts = await pool.query("select case_id, title, assigned_to, deleted_at from case_actions where id=$1", [actionA]);
  assert.equal(actionAfterWriteAttempts.rows[0].case_id, ids.caseA, "invalid action reassignment must not change its case link");
  assert.equal(actionAfterWriteAttempts.rows[0].title, "Action A", "cross-office action update must not mutate data");
  assert.equal(actionAfterWriteAttempts.rows[0].assigned_to, ids.userA, "invalid assignee assignment must not change the assignee");
  assert.equal(actionAfterWriteAttempts.rows[0].deleted_at, null, "cross-office action delete must not soft-delete data");
  // General business writes must reject viewers and re-check role/active state
  // after waiting for the actor row locks, not rely on requireAuth's earlier snapshot.
  const viewerAccount = roleAccounts.find(account => account.role === "viewer");
  const viewerWrite = await request("/api/clients", {
    token: viewerAccount.token, csrf: viewerAccount.csrf, method: "POST",
    body: { client_type: "individual", full_name: "Viewer Forbidden Client", national_id: "5566778899" }
  });
  assert.equal(viewerWrite.status, 403, "viewer must not create clients even with a valid session");
  assert.equal((await pool.query("select count(*)::int as count from clients where full_name='Viewer Forbidden Client'")).rows[0].count, 0,
    "denied viewer write must not persist a client");

  const waitForGeneralActorLockWait = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const waiting = await pool.query(
        "select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and (query ilike '%lock_live_document_actor%' or query ilike 'update auth_sessions set last_seen_at%')"
      );
      if (waiting.rowCount > 0) return waiting.rows[0].pid;
      await delay(25);
    }
    throw new Error("Timed out waiting for a business-write request to block on the live actor row lock");
  };

  const roleRaceAccount = roleAccounts.find(account => account.role === "lawyer");
  const roleGate = await pool.connect();
  let roleGateOpen = false;
  try {
    await roleGate.query("begin");
    roleGateOpen = true;
    await roleGate.query("update users set role='viewer' where id=$1", [roleRaceAccount.id]);
    const pendingRoleWrite = request("/api/clients", {
      token: roleRaceAccount.token, csrf: roleRaceAccount.csrf, method: "POST",
      body: { client_type: "individual", full_name: "Role-Race Forbidden Client", national_id: "6677889900" }
    });
    await waitForGeneralActorLockWait();
    await roleGate.query("commit");
    roleGateOpen = false;
    const roleRaceResult = await pendingRoleWrite;
    assert.equal(roleRaceResult.status, 403, "a role downgrade committed while the request waited must be enforced in-transaction");
    assert.equal((await pool.query("select count(*)::int as count from clients where full_name='Role-Race Forbidden Client'")).rows[0].count, 0,
      "role downgrade race must not persist a client");
  } finally {
    if (roleGateOpen) await roleGate.query("rollback").catch(() => {});
    roleGate.release();
    await pool.query("update users set role='lawyer' where id=$1", [roleRaceAccount.id]);
  }

  const deactivationAccount = roleAccounts.find(account => account.role === "assistant");
  const deactivateGate = await pool.connect();
  let deactivateGateOpen = false;
  try {
    await deactivateGate.query("begin");
    deactivateGateOpen = true;
    await deactivateGate.query("update users set is_active=false where id=$1", [deactivationAccount.id]);
    const pendingDeactivatedWrite = request("/api/cases/" + ids.caseA, {
      token: deactivationAccount.token, csrf: deactivationAccount.csrf, method: "PATCH",
      body: { title: "Must not commit after deactivation" }
    });
    await waitForGeneralActorLockWait();
    await deactivateGate.query("commit");
    deactivateGateOpen = false;
    const deactivatedResult = await pendingDeactivatedWrite;
    assert.equal(deactivatedResult.status, 401, "a deactivation committed while the request waited must invalidate the write");
    assert.equal((await pool.query("select title from cases where id=$1", [ids.caseA])).rows[0].title, "Case A",
      "deactivation race must not mutate the case");
  } finally {
    if (deactivateGateOpen) await deactivateGate.query("rollback").catch(() => {});
    deactivateGate.release();
    await pool.query("update users set is_active=true where id=$1", [deactivationAccount.id]);
  }
  // Revoke a session while a general business write is queued on the actor lock.
  // The test transaction changes only disposable PostgreSQL fixtures.
  const revokeRaceAccount = roleAccounts.find(account => account.role === "admin");
  const revokeGate = await pool.connect();
  let revokeGateOpen = false;
  try {
    await revokeGate.query("begin");
    revokeGateOpen = true;
    const revokeTarget = await revokeGate.query(
      "update auth_sessions set revoked_at=now() where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null returning id",
      [hash(revokeRaceAccount.token), revokeRaceAccount.id, ids.officeA]
    );
    assert.equal(revokeTarget.rowCount, 1, "fixture must have a live disposable session to revoke");
    const pendingRevokedWrite = request("/api/clients", {
      token: revokeRaceAccount.token, csrf: revokeRaceAccount.csrf, method: "POST",
      body: { client_type: "individual", full_name: "Revoked-Session Forbidden Client", national_id: "7788990011" }
    });
    await waitForGeneralActorLockWait();
    await revokeGate.query("commit");
    revokeGateOpen = false;
    const revokedWriteResult = await pendingRevokedWrite;
    assert.equal(revokedWriteResult.status, 401, "a session revoked while the business write waits must not authorize the write");
    assert.equal((await pool.query("select count(*)::int as count from clients where full_name='Revoked-Session Forbidden Client'")).rows[0].count, 0,
      "revoked-session race must not persist a client");
  } finally {
    if (revokeGateOpen) await revokeGate.query("rollback").catch(() => {});
    revokeGate.release();
    await pool.query("update auth_sessions set revoked_at=null where token_hash=$1 and user_id=$2 and office_id=$3",
      [hash(revokeRaceAccount.token), revokeRaceAccount.id, ids.officeA]);
  }
  console.log("PASS: general business write rejects a session revoked while waiting for the PostgreSQL actor lock");


  // Exercise all 12 business mutation routes against the same three live-authorization
  // races. Each request is deliberately queued behind the relevant PostgreSQL row lock;
  // after the control transaction commits, the handler must reject and leave both
  // business state and audit_logs unchanged.
  const generalMutationRaceCases = [
    {
      label: "client create", method: "POST", path: "/api/clients",
      make: marker => ({ client_type: "individual", full_name: marker, national_id: "889900" + String(generalRaceSequence).padStart(4, "0") }),
      verify: async marker => assert.equal((await pool.query("select count(*)::int as count from clients where full_name=$1", [marker])).rows[0].count, 0, "denied client create must not persist")
    },
    {
      label: "client update", method: "PATCH", path: () => "/api/clients/" + clientA,
      make: marker => ({ full_name: marker }),
      verify: async () => assert.equal((await pool.query("select full_name from clients where id=$1", [clientA])).rows[0].full_name, "Client A", "denied client update must not persist")
    },
    {
      label: "client delete", method: "DELETE", path: () => "/api/clients/" + clientA,
      make: () => undefined,
      verify: async () => assert.equal((await pool.query("select deleted_at from clients where id=$1", [clientA])).rows[0].deleted_at, null, "denied client delete must not soft-delete")
    },
    {
      label: "case create", method: "POST", path: "/api/cases",
      make: marker => ({ client_id: clientA, case_number: marker, title: marker }),
      verify: async marker => assert.equal((await pool.query("select count(*)::int as count from cases where case_number=$1", [marker])).rows[0].count, 0, "denied case create must not persist")
    },
    {
      label: "case update", method: "PATCH", path: () => "/api/cases/" + ids.caseA,
      make: marker => ({ title: marker }),
      verify: async () => assert.equal((await pool.query("select title from cases where id=$1", [ids.caseA])).rows[0].title, "Case A", "denied case update must not persist")
    },
    {
      label: "case delete", method: "DELETE", path: () => "/api/cases/" + ids.caseA,
      make: () => undefined,
      verify: async () => assert.equal((await pool.query("select deleted_at from cases where id=$1", [ids.caseA])).rows[0].deleted_at, null, "denied case delete must not soft-delete")
    },
    {
      label: "hearing create", method: "POST", path: "/api/hearings",
      make: marker => ({ case_id: ids.caseA, hearing_at: new Date(Date.now() + 86400000).toISOString(), hearing_type: "trial", notes: marker }),
      verify: async marker => assert.equal((await pool.query("select count(*)::int as count from hearings where notes=$1", [marker])).rows[0].count, 0, "denied hearing create must not persist")
    },
    {
      label: "hearing update", method: "PATCH", path: () => "/api/hearings/" + hearingA,
      make: marker => ({ notes: marker }),
      verify: async () => assert.equal((await pool.query("select notes from hearings where id=$1", [hearingA])).rows[0].notes, null, "denied hearing update must not persist")
    },
    {
      label: "hearing delete", method: "DELETE", path: () => "/api/hearings/" + hearingA,
      make: () => undefined,
      verify: async () => assert.equal((await pool.query("select deleted_at from hearings where id=$1", [hearingA])).rows[0].deleted_at, null, "denied hearing delete must not soft-delete")
    },
    {
      label: "action create", method: "POST", path: "/api/actions",
      make: marker => ({ case_id: ids.caseA, title: marker, assigned_to: ids.userA }),
      verify: async marker => assert.equal((await pool.query("select count(*)::int as count from case_actions where title=$1", [marker])).rows[0].count, 0, "denied action create must not persist")
    },
    {
      label: "action update", method: "PATCH", path: () => "/api/actions/" + actionA,
      make: marker => ({ title: marker }),
      verify: async () => assert.equal((await pool.query("select title from case_actions where id=$1", [actionA])).rows[0].title, "Action A", "denied action update must not persist")
    },
    {
      label: "action delete", method: "DELETE", path: () => "/api/actions/" + actionA,
      make: () => undefined,
      verify: async () => assert.equal((await pool.query("select deleted_at from case_actions where id=$1", [actionA])).rows[0].deleted_at, null, "denied action delete must not soft-delete")
    }
  ];
  let generalRaceSequence = 0;
  const liveAuthorizationRaceScenarios = [
    {
      name: "role downgrade",
      account: roleAccounts.find(account => account.role === "lawyer"),
      expectedStatus: 403,
      gateMutation: async gate => gate.query("update users set role='viewer' where id=$1", [roleAccounts.find(account => account.role === "lawyer").id]),
      restore: async account => pool.query("update users set role='lawyer' where id=$1", [account.id])
    },
    {
      name: "account deactivation",
      account: roleAccounts.find(account => account.role === "assistant"),
      expectedStatus: 401,
      gateMutation: async gate => gate.query("update users set is_active=false where id=$1", [roleAccounts.find(account => account.role === "assistant").id]),
      restore: async account => pool.query("update users set is_active=true where id=$1", [account.id])
    },
    {
      name: "session revocation",
      account: roleAccounts.find(account => account.role === "admin"),
      expectedStatus: 401,
      gateMutation: async (gate, account) => gate.query(
        "update auth_sessions set revoked_at=now() where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null returning id",
        [hash(account.token), account.id, ids.officeA]
      ),
      restore: async account => pool.query(
        "update auth_sessions set revoked_at=null where token_hash=$1 and user_id=$2 and office_id=$3",
        [hash(account.token), account.id, ids.officeA]
      )
    }
  ];
  for (const scenario of liveAuthorizationRaceScenarios) {
    for (const mutationCase of generalMutationRaceCases) {
      generalRaceSequence++;
      const markerText = "race-" + scenario.name.replaceAll(" ", "-") + "-" + mutationCase.label.replaceAll(" ", "-") + "-" + generalRaceSequence;
      const account = scenario.account;
      const gate = await pool.connect();
      let gateOpen = false;
      try {
        await gate.query("begin");
        gateOpen = true;
        const controlResult = await scenario.gateMutation(gate, account);
        if (scenario.name === "session revocation") {
          assert.equal(controlResult.rowCount, 1, "session race must lock one live disposable session");
        }
        const auditBefore = Number((await pool.query("select count(*)::bigint as count from audit_logs")).rows[0].count);
        const pathValue = typeof mutationCase.path === "function" ? mutationCase.path() : mutationCase.path;
        const bodyValue = mutationCase.make(markerText);
        const pendingWrite = request(pathValue, {
          token: account.token, csrf: account.csrf, method: mutationCase.method,
          ...(bodyValue === undefined ? {} : { body: bodyValue })
        });
        await waitForGeneralActorLockWait();
        await gate.query("commit");
        gateOpen = false;
        const response = await pendingWrite;
        assert.equal(response.status, scenario.expectedStatus,
          scenario.name + " must reject " + mutationCase.label + "; got " + response.status + ": " + JSON.stringify(response.body));
        await mutationCase.verify(markerText);
        const auditAfter = Number((await pool.query("select count(*)::bigint as count from audit_logs")).rows[0].count);
        assert.equal(auditAfter, auditBefore, scenario.name + " " + mutationCase.label + " rejection must not write an audit event");
        console.log("PASS: " + scenario.name + " race rejects " + mutationCase.label + " without business or audit mutation");
      } finally {
        if (gateOpen) await gate.query("rollback").catch(() => {});
        gate.release();
        await scenario.restore(account);
      }
    }
  }
  console.log("PASS: 36 live-authorization race cases cover create/update/delete for clients, cases, hearings and actions under role downgrade, account deactivation and session revocation");

  console.log("PASS: client/case writes reject viewer role and re-check concurrent role downgrade and user deactivation under PostgreSQL actor locks");

  console.log("PASS: cross-office HTTP mutation isolation for clients, cases, hearings and actions");

  console.log("PASS: cross-office HTTP isolation for clients, cases, hearings, actions and assignees");

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

  // A soft-deleted document keeps its idempotency key reserved, but must never be replayed or recreated.
  const deletedIdempotent = await request(`/api/case-documents/${idempotentFirst.body.data.id}`, {
    token: tokenA, csrf: csrfA, method: "DELETE"
  });
  assert.equal(deletedIdempotent.status, 204, "idempotent fixture document should soft-delete");
  const deletedIdempotentState = await pool.query(
    "select deleted_at from case_documents where id=$1",
    [idempotentFirst.body.data.id]
  );
  assert.ok(deletedIdempotentState.rows[0].deleted_at, "deleted idempotent document must remain soft-deleted");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_documents where office_id=$1 and created_by=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, "retry-key-12345678"]
  )).rows[0].count, 1, "retry after deletion must not create a second row");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'",
    [idempotentFirst.body.data.id]
  )).rows[0].count, 1, "soft deletion of idempotent document must be audited once");

  const concurrentPayload = { case_id: ids.caseA, title: "Concurrent idempotency regression", document_type: "contract" };
  const concurrentKey = "concurrent-key-12345";
  const concurrentCreates = await Promise.all([
    request("/api/case-documents", { token: tokenA, csrf: csrfA, method: "POST", idempotencyKey: concurrentKey, body: concurrentPayload }),
    request("/api/case-documents", { token: tokenA, csrf: csrfA, method: "POST", idempotencyKey: concurrentKey, body: concurrentPayload })
  ]);
  assert.deepEqual(concurrentCreates.map(result => result.status).sort(), [200, 201],
    "concurrent same-key creates should yield one creation and one replay");
  assert.equal(concurrentCreates[0].body.data.id, concurrentCreates[1].body.data.id,
    "concurrent idempotent requests must return the same document");
  const concurrentAudit = await pool.query(
    "select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='create'",
    [concurrentCreates[0].body.data.id]
  );
  assert.equal(concurrentAudit.rows[0].count, 1, "concurrent retry must create exactly one audit event");
  // Discarding the first committed response models a network loss after commit.
  const patchReplayFixture=(await pool.query("insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Before idempotent PATCH','evidence',$3,$3) returning id",[ids.officeA,ids.caseA,ids.userA])).rows[0].id;
  const patchReplayKey="patch-replay-key-0001",patchReplayPayload={title:"After idempotent PATCH"};
  const discardedPatchResponse=await request("/api/case-documents/"+patchReplayFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:patchReplayKey,body:patchReplayPayload});
  assert.equal(discardedPatchResponse.status,200,"first keyed PATCH must commit");
  const patchReplay=await request("/api/case-documents/"+patchReplayFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:patchReplayKey,body:patchReplayPayload});
  assert.equal(patchReplay.status,200,"retry after a lost PATCH response must replay successfully");
  assert.equal(patchReplay.body.data.title,"After idempotent PATCH");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'",[patchReplayFixture])).rows[0].count,1,"lost-response PATCH retry must leave exactly one audit event");
  const patchKeyConflict=await request("/api/case-documents/"+patchReplayFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:patchReplayKey,body:{title:"Different payload must conflict"}});
  assert.equal(patchKeyConflict.status,409,"same PATCH key with a different payload must conflict");
  assert.deepEqual(patchKeyConflict.body,{error:"idempotency_key_reused"});
  assert.equal((await pool.query("select title from case_documents where id=$1",[patchReplayFixture])).rows[0].title,"After idempotent PATCH","conflicting payload must not mutate the document");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'",[patchReplayFixture])).rows[0].count,1,"conflicting PATCH must not add an audit event");

  const concurrentPatchFixture=(await pool.query("insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Before concurrent keyed PATCH','evidence',$3,$3) returning id",[ids.officeA,ids.caseA,ids.userA])).rows[0].id;
  const concurrentPatchKey="patch-concurrent-key-01",concurrentPatchPayload={title:"Concurrent keyed PATCH"};
  const concurrentPatches=await Promise.all([
    request("/api/case-documents/"+concurrentPatchFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:concurrentPatchKey,body:concurrentPatchPayload}),
    request("/api/case-documents/"+concurrentPatchFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:concurrentPatchKey,body:concurrentPatchPayload})
  ]);
  assert.deepEqual(concurrentPatches.map(result=>result.status),[200,200],"concurrent identical PATCH requests must both succeed");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'",[concurrentPatchFixture])).rows[0].count,1,"concurrent keyed PATCH must emit exactly one audit event");

  const classificationReplayFixture=(await pool.query("insert into case_documents(office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,'Before keyed classification','evidence','normal',$3,$3) returning id",[ids.officeA,ids.caseA,ids.userA])).rows[0].id;
  const classificationReplayKey="classification-replay-01",classificationPayload={confidentiality:"confidential"};
  const classificationFirst=await request("/api/case-documents/"+classificationReplayFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:classificationReplayKey,body:classificationPayload});
  assert.equal(classificationFirst.status,200,"first keyed confidentiality change must succeed");
  const classificationReplay=await request("/api/case-documents/"+classificationReplayFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:classificationReplayKey,body:classificationPayload});
  assert.equal(classificationReplay.status,200,"same confidentiality request must replay");
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1",[classificationReplayFixture])).rows[0].confidentiality,"confidential");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update' and metadata ? 'confidentiality_change'",[classificationReplayFixture])).rows[0].count,1,"idempotent confidentiality change must create exactly one transition audit");
  const classificationConflict=await request("/api/case-documents/"+classificationReplayFixture,{token:tokenA,csrf:csrfA,method:"PATCH",idempotencyKey:classificationReplayKey,body:{confidentiality:"restricted"}});
  assert.equal(classificationConflict.status,409,"same key with different confidentiality must conflict");
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1",[classificationReplayFixture])).rows[0].confidentiality,"confidential","conflicting classification must not mutate the document");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'",[classificationReplayFixture])).rows[0].count,1,"conflicting classification must not add audit rows");

  const deleteReplayFixture=(await pool.query("insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Delete replay fixture','evidence',$3,$3) returning id",[ids.officeA,ids.caseA,ids.userA])).rows[0].id;
  const deleteReplayKey="delete-replay-key-01";
  const deleteFirst=await request("/api/case-documents/"+deleteReplayFixture,{token:tokenA,csrf:csrfA,method:"DELETE",idempotencyKey:deleteReplayKey});
  assert.equal(deleteFirst.status,204,"first keyed DELETE must succeed");
  const deleteReplay=await request("/api/case-documents/"+deleteReplayFixture,{token:tokenA,csrf:csrfA,method:"DELETE",idempotencyKey:deleteReplayKey});
  assert.equal(deleteReplay.status,204,"retry after a lost DELETE response must replay 204 rather than 404");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'",[deleteReplayFixture])).rows[0].count,1,"keyed DELETE and replay must create exactly one audit event");
  const concurrentDeleteFixture=(await pool.query("insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Concurrent delete replay','evidence',$3,$3) returning id",[ids.officeA,ids.caseA,ids.userA])).rows[0].id;
  const concurrentDeleteKey="delete-concurrent-key-01";
  const concurrentDeletes=await Promise.all([
    request("/api/case-documents/"+concurrentDeleteFixture,{token:tokenA,csrf:csrfA,method:"DELETE",idempotencyKey:concurrentDeleteKey}),
    request("/api/case-documents/"+concurrentDeleteFixture,{token:tokenA,csrf:csrfA,method:"DELETE",idempotencyKey:concurrentDeleteKey})
  ]);
  assert.deepEqual(concurrentDeletes.map(result=>result.status),[204,204],"concurrent identical DELETE retries must both return 204");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'",[concurrentDeleteFixture])).rows[0].count,1,"concurrent DELETE retries must emit exactly one audit event");
  const otherDeleteFixture=(await pool.query("insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Different delete target','evidence',$3,$3) returning id",[ids.officeA,ids.caseA,ids.userA])).rows[0].id;
  const deleteKeyConflict=await request("/api/case-documents/"+otherDeleteFixture,{token:tokenA,csrf:csrfA,method:"DELETE",idempotencyKey:deleteReplayKey});
  assert.equal(deleteKeyConflict.status,409,"DELETE key must not be reused for a different target");
  assert.equal((await pool.query("select deleted_at from case_documents where id=$1",[otherDeleteFixture])).rows[0].deleted_at,null,"conflicting DELETE must not mutate a different document");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'",[otherDeleteFixture])).rows[0].count,0,"conflicting DELETE must not add an audit event");

  // A pre-COMMIT PostgreSQL trigger failure must roll back the document mutation,
  // the durable idempotency reservation, and the audit row as one transaction.
  const preCommitFixture = (await pool.query(
    "insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Before precommit failure','evidence',$3,$3) returning id",
    [ids.officeA, ids.caseA, ids.userA]
  )).rows[0].id;
  const preCommitKey = "precommit-failure-key-01";
  await pool.query(`
    create or replace function fail_case_document_before_commit() returns trigger
    language plpgsql as $fn$
    begin
      if new.title = 'Force precommit failure' then
        raise exception 'simulated failure before COMMIT' using errcode = 'P0001';
      end if;
      return new;
    end;
    $fn$
  `);
  await pool.query("create trigger fail_case_document_before_commit_trigger before update on case_documents for each row execute function fail_case_document_before_commit()");
  const preCommitFailed = await request("/api/case-documents/" + preCommitFixture, {
    token: tokenA, csrf: csrfA, method: "PATCH", idempotencyKey: preCommitKey,
    body: { title: "Force precommit failure" }
  });
  assert.equal(preCommitFailed.status, 500, "trigger failure before COMMIT must return a server error");
  assert.equal((await pool.query("select title from case_documents where id=$1", [preCommitFixture])).rows[0].title,
    "Before precommit failure", "pre-COMMIT failure must roll back the business mutation");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, preCommitKey])).rows[0].count, 0, "pre-COMMIT failure must roll back the idempotency reservation");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2 and action='update'",
    [ids.officeA, preCommitFixture])).rows[0].count, 0, "pre-COMMIT failure must leave no audit row");
  await pool.query("drop trigger fail_case_document_before_commit_trigger on case_documents");
  await pool.query("drop function fail_case_document_before_commit()");
  const preCommitRetry = await request("/api/case-documents/" + preCommitFixture, {
    token: tokenA, csrf: csrfA, method: "PATCH", idempotencyKey: preCommitKey,
    body: { title: "Force precommit failure" }
  });
  assert.equal(preCommitRetry.status, 200, "same key must be reusable after PostgreSQL confirmed rollback");
  assert.equal((await pool.query("select title from case_documents where id=$1", [preCommitFixture])).rows[0].title,
    "Force precommit failure");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, preCommitKey])).rows[0].count, 1, "successful retry must commit one durable idempotency record");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2 and action='update'",
    [ids.officeA, preCommitFixture])).rows[0].count, 1, "successful retry must commit exactly one audit row");

  // Concurrent same-key PATCH requests must have one durable reservation, one mutation,
  // and one audit event (not merely two successful HTTP responses).
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, concurrentPatchKey])).rows[0].count, 1, "concurrent PATCH retries must commit one idempotency row");
  assert.equal((await pool.query("select title from case_documents where id=$1", [concurrentPatchFixture])).rows[0].title,
    "Concurrent keyed PATCH", "concurrent same-key PATCH must apply the mutation exactly once");

  // A replay must re-evaluate current classification and authenticated office scope.
  const scopeReplayAssistant = roleAccounts.find(account => account.role === "assistant");
  const scopeReplayFixture = (await pool.query(
    "insert into case_documents(office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,'Confidential replay scope fixture','evidence','confidential',$3,$3) returning id",
    [ids.officeA, ids.caseA, ids.userA]
  )).rows[0].id;
  const scopeReplayKey = "assistant-patch-replay-01";
  const scopeReplayPayload = { description: "assistant's original permitted update" };
  const assistantPatch = await request("/api/case-documents/" + scopeReplayFixture, {
    token: scopeReplayAssistant.token, csrf: scopeReplayAssistant.csrf, method: "PATCH",
    idempotencyKey: scopeReplayKey, body: scopeReplayPayload
  });
  assert.equal(assistantPatch.status, 200, "assistant may initially edit a confidential document");
  const ownerRestrict = await request("/api/case-documents/" + scopeReplayFixture, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { confidentiality: "restricted" }
  });
  assert.equal(ownerRestrict.status, 200, "owner can raise the document classification");
  const auditBeforeDeniedReplay = (await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, scopeReplayFixture]
  )).rows[0].count;
  const deniedRestrictedReplay = await request("/api/case-documents/" + scopeReplayFixture, {
    token: scopeReplayAssistant.token, csrf: scopeReplayAssistant.csrf, method: "PATCH",
    idempotencyKey: scopeReplayKey, body: scopeReplayPayload
  });
  assert.equal(deniedRestrictedReplay.status, 404, "replay must not bypass current restricted-document read policy");
  assert.equal((await pool.query("select description,confidentiality from case_documents where id=$1", [scopeReplayFixture])).rows[0].description,
    "assistant's original permitted update", "denied replay must not mutate the restricted document");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, scopeReplayFixture]
  )).rows[0].count, auditBeforeDeniedReplay, "denied replay must not append an audit event");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, scopeReplayAssistant.id, scopeReplayKey]
  )).rows[0].count, 1, "denied replay must preserve the original actor-scoped idempotency row");

  const crossOfficeReplay = await request("/api/case-documents/" + scopeReplayFixture, {
    token: tokenB, csrf: csrfB, method: "PATCH",
    idempotencyKey: scopeReplayKey, body: scopeReplayPayload
  });
  assert.equal(crossOfficeReplay.status, 404, "same key from another office must not replay or disclose the foreign document");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeB, ids.userB, scopeReplayKey]
  )).rows[0].count, 0, "cross-office denied attempt must roll back its reservation");
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1", [scopeReplayFixture])).rows[0].confidentiality,
    "restricted", "cross-office replay must not change the document classification");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, scopeReplayFixture]
  )).rows[0].count, auditBeforeDeniedReplay, "cross-office replay must not create an audit event");

  // Race a replay against an owner's confidentiality escalation. Either the replay
  // linearizes first (200) or it observes the new restriction (404); neither ordering
  // may duplicate the mutation/audit, and the final persisted classification must win.
  const accessRaceFixture = (await pool.query(
    "insert into case_documents(office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,'Access change race','evidence','confidential',$3,$3) returning id",
    [ids.officeA, ids.caseA, ids.userA]
  )).rows[0].id;
  const accessRaceAssistant = roleAccounts.find(account => account.role === "assistant");
  const accessRaceKey = "access-race-replay-01";
  const accessRacePayload = { description: "first permitted write" };
  const accessRaceFirst = await request("/api/case-documents/" + accessRaceFixture, {
    token: accessRaceAssistant.token, csrf: accessRaceAssistant.csrf, method: "PATCH",
    idempotencyKey: accessRaceKey, body: accessRacePayload
  });
  assert.equal(accessRaceFirst.status, 200);
  const accessRaceAuditBefore = (await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, accessRaceFixture]
  )).rows[0].count;
  const accessRaceResults = await Promise.all([
    request("/api/case-documents/" + accessRaceFixture, {
      token: tokenA, csrf: csrfA, method: "PATCH", body: { confidentiality: "restricted" }
    }),
    request("/api/case-documents/" + accessRaceFixture, {
      token: accessRaceAssistant.token, csrf: accessRaceAssistant.csrf, method: "PATCH",
      idempotencyKey: accessRaceKey, body: accessRacePayload
    })
  ]);
  assert.equal(accessRaceResults[0].status, 200, "owner classification escalation must commit");
  assert.ok([200,404].includes(accessRaceResults[1].status), "concurrent replay must either linearize before or be denied after escalation");
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1", [accessRaceFixture])).rows[0].confidentiality,
    "restricted", "concurrent replay must not undo the committed access-level escalation");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, accessRaceAssistant.id, accessRaceKey]
  )).rows[0].count, 1, "access race must preserve exactly one actor-scoped idempotency row");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, accessRaceFixture]
  )).rows[0].count, accessRaceAuditBefore + 1, "only the owner escalation may add an audit event during replay race");
  console.log("PASS: concurrent access-level escalation and replay preserve current authorization and exact-once audit");

  console.log("PASS: pre-COMMIT rollback, concurrent PATCH exact-once counts, replay authorization and office-scope isolation");

  console.log("PASS: keyed PATCH/classification/DELETE retries, payload conflicts and exact-once audit");

  // Transient PostgreSQL errors are retryable only after the write transaction is confirmed rolled back.
  const retryPrincipal = roleAccounts[1];
  const retryCreatePrincipal = roleAccounts[3];
  const retryCreateKey = "transient-create-retry-01";
  const retryCreatePayload = { case_id: ids.caseA, title: "Transient create retry", document_type: "evidence", confidentiality: "normal" };
  const insertRetryFixture = async (title, confidentiality = "normal") => {
    const result = await pool.query("insert into case_documents(office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,$3,'evidence',$4,$5,$5) returning id", [ids.officeA, ids.caseA, title, confidentiality, ids.userA]);
    return result.rows[0].id;
  };
  const retryUpdateId = await insertRetryFixture("Before transient update");
  const retryConfidentialityId = await insertRetryFixture("Transient confidentiality retry");
  const retryDeleteId = await insertRetryFixture("Transient delete retry");
  await pool.query("create or replace function fail_transient_document_mutations() returns trigger language plpgsql as $fn$ begin if TG_OP = 'INSERT' and NEW.title = 'Transient create retry' then raise exception 'simulated deadlock' using errcode = '40P01'; end if; if TG_OP = 'UPDATE' and NEW.title = 'Transient update retry' then raise exception 'simulated lock timeout' using errcode = '55P03'; end if; if TG_OP = 'UPDATE' and OLD.title = 'Transient confidentiality retry' and NEW.confidentiality = 'restricted' and OLD.confidentiality is distinct from NEW.confidentiality then raise exception 'simulated statement timeout' using errcode = '57014'; end if; if TG_OP = 'UPDATE' and OLD.title = 'Transient delete retry' and NEW.deleted_at is not null and OLD.deleted_at is null then raise exception 'simulated serialization failure' using errcode = '40001'; end if; return NEW; end; $fn$");
  await pool.query("create trigger fail_transient_document_mutations_trigger before insert or update on case_documents for each row execute function fail_transient_document_mutations()");
  // This isolated integration case uses a fresh test-only rate-limit window after earlier API scenarios.
  await pool.query("delete from public.rate_limit_counters where bucket_name='document_create'");
  const retryPort = port + 6;
  retryServer = spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, PORT: String(retryPort), NODE_ENV: "test", RATE_LIMIT_MODE: "memory", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin, DB_LOCK_TIMEOUT_MS: "20000" }, stdio: ["ignore", "pipe", "pipe"] });
  retryServer.stdout.on("data", chunk => { retryServerOutput += chunk.toString(); });
  retryServer.stderr.on("data", chunk => { retryServerOutput += chunk.toString(); });
  await waitForServer(retryPort);

  // Real PostgreSQL deadlock: the API holds the actor/session and idempotency locks
  // while waiting on a document row; the second transaction holds that document and
  // then requests the actor row. Extra ballast locks make the API transaction the
  // lower-cost deadlock victim so its confirmed rollback and HTTP retry contract are tested.
  const realDeadlockDocId = await insertRetryFixture("Real deadlock target");
  const realDeadlockKey = "real-deadlock-retry-01";
  const realDeadlockPayload = { title: "Real deadlock retried" };
  const deadlockBlocker = await pool.connect();
  let deadlockRequest;
  let deadlockRollbackConfirmed = false;
  try {
    await deadlockBlocker.query("begin");
    await deadlockBlocker.query("insert into users(id,office_id,full_name,email,role) select gen_random_uuid(),$1,'Deadlock ballast '||g,'deadlock-ballast-'||g||'@example.test','owner' from generate_series(1,30) g", [ids.officeA]);
    await deadlockBlocker.query("select id from users where email like 'deadlock-ballast-%@example.test' for update");
    await deadlockBlocker.query("select id from case_documents where id=$1 for update", [realDeadlockDocId]);
    deadlockRequest = request("/api/case-documents/" + realDeadlockDocId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "PATCH", idempotencyKey: realDeadlockKey, body: realDeadlockPayload, portToUse: retryPort });
    const waitForDeadlockApiLock = async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const waiting = await pool.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'select case_id,confidentiality from case_documents%'");
        if (waiting.rows[0].count >= 1) return;
        await delay(25);
      }
      throw new Error("Timed out waiting for API PATCH to block on the held document row");
    };
    await waitForDeadlockApiLock();
    let blockerDeadlockError = null;
    try {
      await deadlockBlocker.query("update users set role=role where id=$1", [retryPrincipal.id]);
    } catch (error) {
      blockerDeadlockError = error;
    }
    const deadlockResponse = await deadlockRequest;
    assert.equal(blockerDeadlockError, null, "ballast transaction should survive while PostgreSQL aborts the smaller API transaction");
    assert.equal(deadlockResponse.status, 503, "real PostgreSQL deadlock with confirmed rollback must return retryable 503");
    assert.deepEqual(deadlockResponse.body, { error: "database_retryable" });
    await deadlockBlocker.query("rollback");
    deadlockRollbackConfirmed = true;
  } finally {
    await deadlockBlocker.query("rollback").catch(()=>{});
    deadlockBlocker.release();
    if (deadlockRequest) await deadlockRequest.catch(()=>{});
    await pool.query("delete from users where email like 'deadlock-ballast-%@example.test'").catch(()=>{});
  }
  assert.equal(deadlockRollbackConfirmed, true, "blocker transaction must be explicitly rolled back to release its locks");
  assert.equal((await pool.query("select title from case_documents where id=$1", [realDeadlockDocId])).rows[0].title, "Real deadlock target", "aborted API transaction must not mutate document metadata");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3", [ids.officeA, retryPrincipal.id, realDeadlockKey])).rows[0].count, 0, "confirmed deadlock rollback must remove the uncommitted idempotency record");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [realDeadlockDocId])).rows[0].count, 0, "deadlock rollback must leave no audit event");
  const realDeadlockRetry = await request("/api/case-documents/" + realDeadlockDocId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "PATCH", idempotencyKey: realDeadlockKey, body: realDeadlockPayload, portToUse: retryPort });
  assert.equal(realDeadlockRetry.status, 200, "same idempotency key and fingerprint must succeed after confirmed deadlock rollback");
  assert.equal(realDeadlockRetry.body.data.title, realDeadlockPayload.title);
  const realDeadlockReplay = await request("/api/case-documents/" + realDeadlockDocId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "PATCH", idempotencyKey: realDeadlockKey, body: realDeadlockPayload, portToUse: retryPort });
  assert.equal(realDeadlockReplay.status, 200, "repeat of committed retry must replay successfully");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [realDeadlockDocId])).rows[0].count, 1, "real deadlock retry and replay must produce exactly one audit event");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3 and response_status=200", [ids.officeA, retryPrincipal.id, realDeadlockKey])).rows[0].count, 1, "successful retry must persist one completed idempotency record");
  console.log("PASS: real PostgreSQL deadlock aborts API transaction, releases locks, retries with same key, and writes exactly one audit event");

  const transientCreateFailed = await request("/api/case-documents", { token: retryCreatePrincipal.token, csrf: retryCreatePrincipal.csrf, method: "POST", idempotencyKey: retryCreateKey, body: retryCreatePayload, portToUse: retryPort });
  assert.equal(transientCreateFailed.status, 503, "deadlock with confirmed rollback should be explicitly retryable");
  assert.deepEqual(transientCreateFailed.body, { error: "database_retryable" });
  assert.equal((await pool.query("select count(*)::int as count from case_documents where title=$1", [retryCreatePayload.title])).rows[0].count, 0, "deadlocked create must roll back its document and idempotency key");
  const transientUpdateBody = { title: "Transient update retry" };
  const transientUpdateFailed = await request("/api/case-documents/" + retryUpdateId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "PATCH", body: transientUpdateBody });
  assert.equal(transientUpdateFailed.status, 503, "lock timeout with confirmed rollback should be retryable");
  assert.deepEqual(transientUpdateFailed.body, { error: "database_retryable" });
  assert.equal((await pool.query("select title from case_documents where id=$1", [retryUpdateId])).rows[0].title, "Before transient update", "lock-timeout update must roll back");
  const transientConfidentialityFailed = await request("/api/case-documents/" + retryConfidentialityId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "PATCH", body: { confidentiality: "restricted" } });
  assert.equal(transientConfidentialityFailed.status, 503, "statement timeout with confirmed rollback should be retryable");
  assert.deepEqual(transientConfidentialityFailed.body, { error: "database_retryable" });
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1", [retryConfidentialityId])).rows[0].confidentiality, "normal", "timed-out classification must roll back");
  const transientDeleteFailed = await request("/api/case-documents/" + retryDeleteId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "DELETE" });
  assert.equal(transientDeleteFailed.status, 503, "serialization failure with confirmed rollback should be retryable");
  assert.deepEqual(transientDeleteFailed.body, { error: "database_retryable" });
  assert.equal((await pool.query("select deleted_at from case_documents where id=$1", [retryDeleteId])).rows[0].deleted_at, null, "failed delete must roll back soft deletion");
  for (const id of [retryUpdateId, retryConfidentialityId, retryDeleteId]) {
    assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action in ('update','delete')", [id])).rows[0].count, 0, "rolled-back writes must not leave audit rows");
  }
  await pool.query("drop trigger fail_transient_document_mutations_trigger on case_documents");
  await pool.query("drop function fail_transient_document_mutations()");
  const transientCreateRetried = await request("/api/case-documents", { token: retryCreatePrincipal.token, csrf: retryCreatePrincipal.csrf, method: "POST", idempotencyKey: retryCreateKey, body: retryCreatePayload, portToUse: retryPort });
  assert.equal(transientCreateRetried.status, 201, "same idempotency key must succeed after deadlock rollback");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='create'", [transientCreateRetried.body.data.id])).rows[0].count, 1, "retried create must have exactly one audit event");
  const transientUpdateRetried = await request("/api/case-documents/" + retryUpdateId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "PATCH", body: transientUpdateBody });
  assert.equal(transientUpdateRetried.status, 200);
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [retryUpdateId])).rows[0].count, 1, "retried update must have exactly one audit event");
  const transientConfidentialityRetried = await request("/api/case-documents/" + retryConfidentialityId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "PATCH", body: { confidentiality: "restricted" } });
  assert.equal(transientConfidentialityRetried.status, 200);
  assert.equal(transientConfidentialityRetried.body.data.confidentiality, "restricted");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [retryConfidentialityId])).rows[0].count, 1, "retried classification must have exactly one audit event");
  const transientDeleteRetried = await request("/api/case-documents/" + retryDeleteId, { token: retryPrincipal.token, csrf: retryPrincipal.csrf, method: "DELETE" });
  assert.equal(transientDeleteRetried.status, 204);
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='delete'", [retryDeleteId])).rows[0].count, 1, "retried delete must have exactly one audit event");
  console.log("PASS: transient DB failures roll back and retryable create/update/classification/delete each leave one audit event");

  console.log("PASS: concurrent idempotency retries create one document and one audit event");


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
  const auditPort = port + 5;
  auditServer = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(auditPort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"]
  });
  auditServer.stdout.on("data", chunk => { auditServerOutput += chunk.toString(); });
  auditServer.stderr.on("data", chunk => { auditServerOutput += chunk.toString(); });
  await waitForServer(auditPort);
  const createAuditBeforeFailure = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and action='create'");
  const failedCreate = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { case_id: ids.caseA, title: "Create must roll back with audit" }, portToUse: auditPort
  });
  assert.equal(failedCreate.status, 500, "audit failure must reject document creation");
  assert.deepEqual(failedCreate.body, { error: "database_error" }, "create audit failure response must be sanitized");
  assert.equal(auditServerOutput.includes("forced audit failure for rollback test"), false,
    "server stderr must not expose raw database exception messages");
  assert.equal(auditServerOutput.includes("Create must roll back with audit"), false,
    "server stderr must not echo sensitive request/document values");
  assert.equal(auditServerOutput.includes(tokenA), false, "server stderr must not disclose session tokens");
  assert.equal(auditServerOutput.includes(csrfA), false, "server stderr must not disclose CSRF tokens");
  const failedCreateRow = await pool.query("select count(*)::int as count from case_documents where title='Create must roll back with audit'");
  assert.equal(failedCreateRow.rows[0].count, 0, "failed create must roll back the document row");
  const failedCreateAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and action='create'");
  assert.equal(failedCreateAudit.rows[0].count, createAuditBeforeFailure.rows[0].count, "failed create must not leave an audit row");
  const failedIdempotentCreate = await request("/api/case-documents", {
    // Use a separate office-A admin principal so this rollback assertion is not
    // masked by the owner principal's independent create-rate-limit budget.
    token: roleAccounts[1].token, csrf: roleAccounts[1].csrf, method: "POST", idempotencyKey: "retry-after-db-failure-01", portToUse: auditPort,
    body: { case_id: ids.caseA, title: "Idempotent create database failure retry" }
  });
  assert.equal(failedIdempotentCreate.status, 500, "audit failure must fail idempotent creation");
  const failedIdempotentRows = await pool.query("select count(*)::int as count from case_documents where title='Idempotent create database failure retry'");
  assert.equal(failedIdempotentRows.rows[0].count, 0, "failed idempotent create must roll back its document and key");

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
  const failedClassification = await request(`/api/case-documents/${documentId}`, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { confidentiality: "confidential" }
  });
  assert.equal(failedClassification.status, 500, "classification change must fail when its audit insert fails");
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1", [documentId])).rows[0].confidentiality,
    "restricted", "classification change must roll back when audit insert fails");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [documentId])).rows[0].count,
    0, "failed classification update must not leave an audit row");
  await pool.query("drop trigger reject_document_mutation_audit_trigger on audit_logs");
  const ownUpdate = await request(`/api/case-documents/${documentId}`, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { title: "Updated by Office A" }
  });
  assert.equal(ownUpdate.status, 200, "office A can update its own document");
  assert.equal(ownUpdate.body.data.document_type, "evidence", "title-only patch must not silently reset document type to the create default");
  const firstUpdateAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [documentId]);
  assert.equal(firstUpdateAudit.rows[0].count, 1, "first successful update must create exactly one audit event");
  const confidentialityUpdate = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA, method: "PATCH", body: { confidentiality: "normal" } });
  assert.equal(confidentialityUpdate.status, 200);
  assert.equal(confidentialityUpdate.body.data.confidentiality, "normal");
  const updatedDetail = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA });
  assert.equal(updatedDetail.body.data.confidentiality, "normal", "detail endpoint must reflect confidentiality updates");
  const invalidConfidentiality = await request(`/api/case-documents/${documentId}`, { token: tokenA, csrf: csrfA, method: "PATCH", body: { confidentiality: "public" } });
  assert.equal(invalidConfidentiality.status, 400);
  const updateAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [documentId]);
  assert.equal(updateAudit.rows[0].count, 2, "each of two successful updates must be audited exactly once");

  const lifecycleAuditRows = await pool.query(
    "select office_id, user_id, action, entity_type, entity_id, metadata from audit_logs where entity_type='case_document' and entity_id=$1 order by created_at asc",
    [documentId]
  );
  assert.equal(lifecycleAuditRows.rowCount, 3, "create and both successful updates must have one audit row each");
  assert.deepEqual(lifecycleAuditRows.rows.map(row => row.action), ["create", "update", "update"]);
  for (const row of lifecycleAuditRows.rows) {
    assert.equal(row.office_id, ids.officeA, "lifecycle audit metadata must remain scoped to the actor's office");
    assert.equal(row.user_id, ids.userA, "lifecycle audit event must identify the authenticated actor");
    assert.equal(row.entity_type, "case_document");
    assert.equal(row.entity_id, documentId);
  }
  assert.deepEqual(lifecycleAuditRows.rows[0].metadata, {
    storage_status: "metadata_only"
  }, "create audit must omit relationship UUIDs and retain only intended non-content metadata");
  assert.deepEqual(lifecycleAuditRows.rows[1].metadata, { fields: ["title"] },
    "ordinary update audit must record changed field names, not submitted field values");
  assert.deepEqual(lifecycleAuditRows.rows[2].metadata, {
    fields: ["confidentiality"],
    confidentiality_change: { from: "restricted", to: "normal" }
  }, "classification audit must capture the exact persisted from→to transition and no document contents");
  const serializedLifecycleMetadata = JSON.stringify(lifecycleAuditRows.rows.map(row => row.metadata));
  for (const sensitiveValue of ["Confidential Office A document", "Updated by Office A", "session", "csrf", "authorization"]) {
    assert.equal(serializedLifecycleMetadata.includes(sensitiveValue), false,
      `audit metadata must not contain document content or authentication material: ${sensitiveValue}`);
  }
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

  const documentAuditRows = await pool.query(
    "select office_id, user_id, entity_type, entity_id, action from audit_logs where entity_type='case_document' and entity_id=$1",
    [documentId]
  );
  assert.equal(documentAuditRows.rows.length, 4, "the document must have exactly one create, two updates, and one delete audit event");
  assert.deepEqual(
    documentAuditRows.rows.map(row => row.action).sort(),
    ["create", "delete", "update", "update"],
    "audit actions must match the successful document lifecycle exactly"
  );
  for (const row of documentAuditRows.rows) {
    assert.equal(row.office_id, ids.officeA, "every document audit event must be attributed to the owning office");
    assert.equal(row.user_id, ids.userA, "every document audit event must identify the authenticated actor");
    assert.equal(row.entity_type, "case_document", "every lifecycle audit event must identify the document entity type");
    assert.equal(row.entity_id, documentId, "every lifecycle audit event must point to the exact document");
  }

  
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
    token: tokenA, csrf: csrfA, method: "POST", portToUse: auditPort,
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
    env: { ...process.env, PORT: String(timeoutPort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin, DB_STATEMENT_TIMEOUT_MS: "750", DB_LOCK_TIMEOUT_MS: "200" },
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
  assert.equal(timeoutResponse.status, 503, "database statement timeout with confirmed rollback must be retryable without hanging");
  const timeoutBody = await timeoutResponse.json();
  assert.deepEqual(timeoutBody, { error: "database_retryable" }, "statement timeout response must be sanitized and marked retryable");
  assert.equal(JSON.stringify(timeoutBody).includes("statement timeout"), false, "statement timeout details must not be disclosed");
  const afterTimeout = await pool.query("select title from case_documents where id=$1", [timeoutId]);
  assert.equal(afterTimeout.rows[0].title, "Database statement timeout regression", "timed-out update must roll back");
  const timeoutAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'", [timeoutId]);
  assert.equal(timeoutAudit.rows[0].count, 0, "timed-out update must not leave an audit record");
  await pool.query("drop trigger delay_target_document_update_trigger on case_documents");
  await pool.query("drop function delay_target_document_update()");
  // Real row-lock contention (not a synthetic SQLSTATE): auth succeeds, but the
  // in-transaction actor revalidation waits on the user's row and hits lock_timeout.
  // This proves a timed-out authorization wait cannot mutate the document or leave idempotency/audit rows.
  const actorLockTimeoutKey = "actor-lock-timeout-2026-10-01";
  const actorLockGate = await pool.connect();
  let actorLockGateOpen = false;
  let actorLockRequest;
  try {
    await actorLockGate.query("begin");
    await actorLockGate.query("select id from users where id=$1 for update", [ids.userA]);
    actorLockGateOpen = true;
    actorLockRequest = request(`/api/case-documents/${timeoutId}`, {
      token: tokenA, csrf: csrfA, method: "PATCH", portToUse: timeoutPort,
      idempotencyKey: actorLockTimeoutKey,
      body: { title: "Must not commit after actor-lock timeout" }
    });
    const waitDeadline = Date.now() + 5000;
    let observedActorLockWait = false;
    while (Date.now() < waitDeadline) {
      const waiting = await pool.query(`
        select count(*)::int as count
        from pg_stat_activity
        where datname=current_database()
          and wait_event_type='Lock'
          and query ilike 'select valid, actor_role from public.lock_live_document_actor%'
      `);
      if (waiting.rows[0].count > 0) {
        observedActorLockWait = true;
        break;
      }
      await delay(10);
    }
    assert.equal(observedActorLockWait, true,
      "the HTTP write must be observed waiting on the actual PostgreSQL actor-lock helper");
    const actorLockTimeoutResponse = await actorLockRequest;
    assert.equal(actorLockTimeoutResponse.status, 503,
      "a real actor-row lock wait that reaches lock_timeout must be explicitly retryable after rollback");
    assert.deepEqual(actorLockTimeoutResponse.body, { error: "database_retryable" },
      "actor-lock timeout response must not expose database internals");
  } finally {
    if (actorLockGateOpen) await actorLockGate.query("rollback").catch(() => {});
    actorLockGate.release();
    if (actorLockRequest) await actorLockRequest.catch(() => {});
  }
  const actorLockTimeoutState = await pool.query("select title from case_documents where id=$1", [timeoutId]);
  assert.equal(actorLockTimeoutState.rows[0].title, "Database statement timeout regression",
    "actor-lock timeout must roll back the attempted document update");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, actorLockTimeoutKey]
  )).rows[0].count, 0, "actor-lock timeout occurs before idempotency reservation and must leave no reservation");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'",
    [timeoutId]
  )).rows[0].count, 0, "actor-lock timeout must not emit an audit event");
  const afterActorLockRelease = await request(`/api/case-documents/${timeoutId}`, {
    token: tokenA, csrf: csrfA, method: "PATCH", portToUse: timeoutPort,
    idempotencyKey: actorLockTimeoutKey, body: { title: "Recovered after actor-lock timeout" }
  });
  assert.equal(afterActorLockRelease.status, 200,
    "after the blocker releases its row lock, a fresh request must acquire authorization locks and complete");
  assert.equal(afterActorLockRelease.body.data.title, "Recovered after actor-lock timeout");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='update'",
    [timeoutId]
  )).rows[0].count, 1, "only the post-timeout successful mutation may be audited");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3 and response_status=200",
    [ids.officeA, ids.userA, actorLockTimeoutKey]
  )).rows[0].count, 1, "successful retry after lock timeout must leave one completed idempotency record");
  console.log("PASS: real PostgreSQL actor-lock wait hits lock_timeout, rolls back without audit/idempotency residue, releases locks, and a fresh write succeeds");

  // The general CRUD handlers used to issue a raw ROLLBACK and classify the
  // resulting 55P03 as a generic 500. Exercise the real /api/clients write path
  // under a genuine actor-row lock wait and prove confirmed rollback is retryable.
  const clientLockTimeoutName = "Client Lock Timeout Recovery";
  const clientLockTimeoutNationalId = "9911223344";
  const clientLockGate = await pool.connect();
  let clientLockGateOpen = false;
  let clientLockRequest;
  const clientCreateAuditBefore = (await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='client' and action='create'",
    [ids.officeA]
  )).rows[0].count;
  try {
    await clientLockGate.query("begin");
    await clientLockGate.query("select id from users where id=$1 for update", [ids.userA]);
    clientLockGateOpen = true;
    clientLockRequest = request("/api/clients", {
      token: tokenA, csrf: csrfA, method: "POST", portToUse: timeoutPort,
      body: { client_type: "individual", full_name: clientLockTimeoutName, national_id: clientLockTimeoutNationalId }
    });
    const waitDeadline = Date.now() + 5000;
    let observedClientActorWait = false;
    while (Date.now() < waitDeadline) {
      const waiting = await pool.query(`
        select count(*)::int as count
        from pg_stat_activity
        where datname=current_database()
          and wait_event_type='Lock'
          and query ilike 'select valid, actor_role from public.lock_live_document_actor%'
      `);
      if (waiting.rows[0].count > 0) {
        observedClientActorWait = true;
        break;
      }
      await delay(10);
    }
    assert.equal(observedClientActorWait, true, "client creation must be observed waiting on the PostgreSQL actor lock");
    const response = await clientLockRequest;
    assert.equal(response.status, 503, "confirmed rollback after lock_timeout must return retryable 503 for ordinary CRUD routes");
    assert.deepEqual(response.body, { error: "database_retryable" });
  } finally {
    if (clientLockGateOpen) await clientLockGate.query("rollback").catch(() => {});
    clientLockGate.release();
    if (clientLockRequest) await clientLockRequest.catch(() => {});
  }
  assert.equal((await pool.query("select count(*)::int as count from clients where office_id=$1 and full_name=$2", [ids.officeA, clientLockTimeoutName])).rows[0].count, 0,
    "timed-out client creation must leave no business row");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='client' and action='create'", [ids.officeA])).rows[0].count, clientCreateAuditBefore,
    "timed-out client creation must leave no audit row");
  const recoveredClientCreate = await request("/api/clients", {
    token: tokenA, csrf: csrfA, method: "POST", portToUse: timeoutPort,
    body: { client_type: "individual", full_name: clientLockTimeoutName, national_id: clientLockTimeoutNationalId }
  });
  assert.equal(recoveredClientCreate.status, 201, "client creation must recover after actor lock is released");
  assert.equal((await pool.query("select count(*)::int as count from clients where office_id=$1 and full_name=$2", [ids.officeA, clientLockTimeoutName])).rows[0].count, 1);
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='client' and action='create'", [ids.officeA])).rows[0].count, clientCreateAuditBefore + 1,
    "recovered client creation must produce exactly one audit event");
  console.log("PASS: client create actor-lock timeout rolls back and recovers with one business row and one audit event");

  // Opposite-direction hearing moves used to update the old case summary before
  // the new one. Concurrent A→B and B→A requests could therefore hold A/B in
  // opposite order and deadlock. The trigger creates a real overlap in PostgreSQL.
  const lockOrderCaseA = (await pool.query(
    "insert into cases(office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,'LOCK-ORDER-A','Lock order case A',$3,$3) returning id",
    [ids.officeA, clientA, ids.userA]
  )).rows[0].id;
  const lockOrderCaseB = (await pool.query(
    "insert into cases(office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,'LOCK-ORDER-B','Lock order case B',$3,$3) returning id",
    [ids.officeA, clientA, ids.userA]
  )).rows[0].id;
  const lockOrderHearingA = (await pool.query(
    "insert into hearings(office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,now()+interval '2 days','trial','scheduled',$3,$3) returning id",
    [ids.officeA, lockOrderCaseA, ids.userA]
  )).rows[0].id;
  const lockOrderHearingB = (await pool.query(
    "insert into hearings(office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,now()+interval '3 days','trial','scheduled',$3,$3) returning id",
    [ids.officeA, lockOrderCaseB, ids.userA]
  )).rows[0].id;
  await pool.query(`
    create or replace function pause_lock_order_case_summary() returns trigger language plpgsql as $fn$
    begin
      if new.case_number like 'LOCK-ORDER-%' then perform pg_sleep(0.25); end if;
      return new;
    end;
    $fn$;
    create trigger pause_lock_order_case_summary_trigger before update on cases
      for each row execute function pause_lock_order_case_summary();
  `);
  try {
    const moveAtoB = request("/api/hearings/" + lockOrderHearingA, {
      token: tokenA, csrf: csrfA, method: "PATCH",
      body: { case_id: lockOrderCaseB }
    });
    const moveBtoA = request("/api/hearings/" + lockOrderHearingB, {
      token: tokenA, csrf: csrfA, method: "PATCH",
      body: { case_id: lockOrderCaseA }
    });
    const [moveAResult, moveBResult] = await Promise.all([moveAtoB, moveBtoA]);
    assert.equal(moveAResult.status, 200, "A→B hearing move must complete without deadlock");
    assert.equal(moveBResult.status, 200, "B→A hearing move must complete without deadlock");
    const finalHearings = await pool.query("select id,case_id from hearings where id=any($1::uuid[])", [[lockOrderHearingA, lockOrderHearingB]]);
    assert.equal(finalHearings.rows.find(row => row.id === lockOrderHearingA).case_id, lockOrderCaseB);
    assert.equal(finalHearings.rows.find(row => row.id === lockOrderHearingB).case_id, lockOrderCaseA);
    const summaryState = await pool.query(`
      select c.id,c.next_hearing_at,
        (select min(h.hearing_at) from hearings h where h.office_id=c.office_id and h.case_id=c.id
          and h.deleted_at is null and h.status in ('scheduled','postponed') and h.hearing_at>=now()) as expected
      from cases c where c.id=any($1::uuid[]) order by c.id
    `, [[lockOrderCaseA, lockOrderCaseB]]);
    assert.equal(summaryState.rowCount, 2);
    for (const row of summaryState.rows) {
      assert.equal(row.next_hearing_at?.toISOString(), row.expected?.toISOString(),
        "case summary must reflect the final serialized hearing assignment");
    }
    for (const hearingId of [lockOrderHearingA, lockOrderHearingB]) {
      assert.equal((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=$2 and action='update'",
        [ids.officeA, hearingId]
      )).rows[0].count, 1, "each committed hearing move must emit one audit event");
    }
  } finally {
    await pool.query("drop trigger if exists pause_lock_order_case_summary_trigger on cases").catch(() => {});
    await pool.query("drop function if exists pause_lock_order_case_summary()").catch(() => {});
  }
  console.log("PASS: concurrent opposite-direction hearing moves use deterministic case-row lock order without deadlock");



  timeoutServer.kill("SIGTERM");
  timeoutServer = null;

  const retriedIdempotentCreate = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", portToUse: auditPort, idempotencyKey: "retry-after-db-failure-01",
    body: { case_id: ids.caseA, title: "Idempotent create database failure retry" }
  });
  assert.equal(retriedIdempotentCreate.status, 201, "same idempotency key must be reusable after a rolled-back database failure");
  const retriedIdempotentAudit = await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1 and action='create'", [retriedIdempotentCreate.body.data.id]);
  assert.equal(retriedIdempotentAudit.rows[0].count, 1, "successful retry after database failure must be audited exactly once");




  const sequentialPoolRequests = [];
  for (let i = 0; i < 30; i++) {
    sequentialPoolRequests.push(await request("/api/case-documents", { token: tokenA, csrf: csrfA }));
  }
  assert.ok(sequentialPoolRequests.every(result => result.status === 200),
    "30 sequential authenticated requests must continue succeeding without leaking checked-out clients");
  const concurrentPoolRequests = await Promise.all(
    Array.from({ length: 24 }, () => request("/api/case-documents", { token: tokenA, csrf: csrfA }))
  );
  assert.ok(concurrentPoolRequests.every(result => result.status === 200),
    "concurrent authenticated requests above pool size must finish after clients are released");
  console.log("PASS: repeated and concurrent requests do not exhaust the PostgreSQL connection pool");

  const rolePort = port + 4;
  roleServer = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(rolePort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"]
  });
  roleServer.stdout.on("data", chunk => { roleServerOutput += chunk.toString(); });
  roleServer.stderr.on("data", chunk => { roleServerOutput += chunk.toString(); });
  await waitForServer(rolePort);

  // Use the isolated role-policy server's fresh in-memory rate-limit budget for
  // the deleted-idempotency replay check; do not perturb later rate-limit regressions.
  const deletedReplay = await request("/api/case-documents", {
    token: tokenA, csrf: csrfA, method: "POST", portToUse: rolePort,
    idempotencyKey: "retry-key-12345678", body: idempotentPayload
  });
  assert.equal(deletedReplay.status, 409, "retry after soft deletion must not resurrect or replay the deleted document");
  assert.deepEqual(deletedReplay.body, { error: "idempotency_key_reused" });

  const createFixture = async (title, confidentiality) => {
    const result = await request("/api/case-documents", { token: tokenA, csrf: csrfA, method: "POST", portToUse: rolePort, body: { case_id: ids.caseA, title, document_type: "evidence", confidentiality } });
    assert.equal(result.status, 201);
    return result.body.data.id;
  };
  const idsByLevel = {
    normal: await createFixture("Policy normal fixture", "normal"),
    confidential: await createFixture("Policy confidential fixture", "confidential"),
    restricted: await createFixture("Policy restricted fixture", "restricted")
  };
  const readable = {owner:["normal","confidential","restricted"],admin:["normal","confidential","restricted"],lawyer:["normal","confidential","restricted"],assistant:["normal","confidential"],viewer:["normal"]};
  // Force a role downgrade after requireAuth has read the session role but before
  // the document GET query runs. The GET query must authorize using the live DB role.
  const roleRaceLawyer = roleAccounts.find(a=>a.role==="lawyer");
  const lawyerTokenHash = hash(roleRaceLawyer.token);
  const roleRaceAdmin = roleAccounts.find(a=>a.role==="admin");
  const adminTokenHash = hash(roleRaceAdmin.token);
  await pool.query(`
    create or replace function delay_lawyer_session_heartbeat() returns trigger language plpgsql as $fn$
    begin
      if old.token_hash in ('${lawyerTokenHash}', '${adminTokenHash}') then perform pg_sleep(0.6); end if;
      return new;
    end;
    $fn$;
    create trigger delay_lawyer_session_heartbeat_trigger
      before update of last_seen_at on auth_sessions
      for each row execute function delay_lawyer_session_heartbeat();
  `);
  const waitForRoleHeartbeat = async () => {
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const waiting=await pool.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Timeout' and query ilike 'update auth_sessions set last_seen_at%'");
      if(waiting.rows[0].count>0)return;
      await delay(10);
    }
    throw new Error("Timed out waiting for role-race heartbeat trigger");
  };
  const waitForActorLockWait = async () => {
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const waiting=await pool.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'select valid, actor_role from public.lock_live_document_actor%'");
      if(waiting.rows[0].count>0)return;
      await delay(10);
    }
    throw new Error("Timed out waiting for document actor row lock");
  };
  try {
    for (const read of [
      {label:"list",path:"/api/case-documents"},
      {label:"detail",path:null}
    ]) {
      await pool.query("update users set role='lawyer' where id=$1",[roleRaceLawyer.id]);
      const pendingRead=request(read.path || `/api/case-documents/${idsByLevel.restricted}`,{
        token:roleRaceLawyer.token,csrf:roleRaceLawyer.csrf,portToUse:rolePort
      });
      await waitForRoleHeartbeat();
      await pool.query("update users set role='viewer' where id=$1",[roleRaceLawyer.id]);
      const response=await pendingRead;
      if(read.label==="list"){
        assert.equal(response.status,200);
        assert.equal(response.body.data.some(d=>d.id===idsByLevel.restricted),false,
          "list must not disclose restricted metadata after role is downgraded during authentication");
      }else{
        assert.equal(response.status,404,
          "detail must hide restricted metadata after role is downgraded during authentication");
        assert.deepEqual(response.body,{error:"document_not_found"});
      }
    }

    // Write requests must reject state changes made after requireAuth read the actor.
    await pool.query("update users set role='lawyer', is_active=true, deleted_at=null where id=$1", [roleRaceLawyer.id]);
    const beforeRoleConfidentiality = (await pool.query("select confidentiality from case_documents where id=$1", [idsByLevel.normal])).rows[0].confidentiality;
    const pendingPatch = request("/api/case-documents/" + idsByLevel.normal, { token: roleRaceLawyer.token, csrf: roleRaceLawyer.csrf, method: "PATCH", portToUse: rolePort, body: { confidentiality: "restricted" } });
    await waitForRoleHeartbeat();
    await pool.query("update users set role='viewer' where id=$1", [roleRaceLawyer.id]);
    const downgradedPatch = await pendingPatch;
    assert.equal(downgradedPatch.status, 403, "confidentiality PATCH must reject a role downgraded after authentication");
    assert.equal((await pool.query("select confidentiality from case_documents where id=$1", [idsByLevel.normal])).rows[0].confidentiality, beforeRoleConfidentiality, "role downgrade race must not change document confidentiality");

    await pool.query("update users set role='lawyer', is_active=true where id=$1", [roleRaceLawyer.id]);
    const beforeInactiveTitle = (await pool.query("select title from case_documents where id=$1", [idsByLevel.normal])).rows[0].title;
    const pendingInactivePatch = request("/api/case-documents/" + idsByLevel.normal, { token: roleRaceLawyer.token, csrf: roleRaceLawyer.csrf, method: "PATCH", portToUse: rolePort, body: { title: "must not update after account deactivation" } });
    await waitForRoleHeartbeat();
    await pool.query("update users set is_active=false where id=$1", [roleRaceLawyer.id]);
    const inactivePatch = await pendingInactivePatch;
    assert.equal(inactivePatch.status, 401, "PATCH must reject account deactivation after authentication");
    assert.equal((await pool.query("select title from case_documents where id=$1", [idsByLevel.normal])).rows[0].title, beforeInactiveTitle, "deactivation race must not mutate metadata");

    await pool.query("update users set is_active=true, role='lawyer' where id=$1", [roleRaceLawyer.id]);
    const revokedClientName = "Session Revocation Race Client";
    const pendingRevokedClient = request("/api/clients", {
      token: roleRaceLawyer.token, csrf: roleRaceLawyer.csrf, method: "POST", portToUse: rolePort,
      body: { client_type: "individual", full_name: revokedClientName, national_id: "8877665544" }
    });
    await waitForRoleHeartbeat();
    await pool.query("update auth_sessions set revoked_at=now() where token_hash=$1", [lawyerTokenHash]);
    const revokedClientResult = await pendingRevokedClient;
    assert.equal(revokedClientResult.status, 401, "client create must reject session revocation after requireAuth captured the session");
    assert.equal((await pool.query("select count(*)::int as count from clients where full_name=$1", [revokedClientName])).rows[0].count, 0,
      "session revocation race must not persist a client");
    await pool.query("update auth_sessions set revoked_at=null where token_hash=$1", [lawyerTokenHash]);

    const pendingRevokedPatch = request("/api/case-documents/" + idsByLevel.normal, { token: roleRaceLawyer.token, csrf: roleRaceLawyer.csrf, method: "PATCH", portToUse: rolePort, body: { title: "must not update after session revocation" } });
    await waitForRoleHeartbeat();
    await pool.query("update auth_sessions set revoked_at=now() where token_hash=$1", [lawyerTokenHash]);
    const revokedPatch = await pendingRevokedPatch;
    assert.equal(revokedPatch.status, 401, "PATCH must reject session revocation after authentication");
    assert.equal((await pool.query("select title from case_documents where id=$1", [idsByLevel.normal])).rows[0].title, beforeInactiveTitle, "revocation race must not mutate metadata");
    await pool.query("update auth_sessions set revoked_at=null where token_hash=$1", [lawyerTokenHash]);

    const adminDocument = await createFixture("Delete must reject downgraded admin", "normal");
    const pendingDelete = request("/api/case-documents/" + adminDocument, { token: roleRaceAdmin.token, csrf: roleRaceAdmin.csrf, method: "DELETE", portToUse: rolePort });
    await waitForRoleHeartbeat();
    await pool.query("update users set role='assistant' where id=$1", [roleRaceAdmin.id]);
    const downgradedDelete = await pendingDelete;
    assert.equal(downgradedDelete.status, 403, "DELETE must reject an admin downgraded after authentication");
    assert.equal((await pool.query("select deleted_at from case_documents where id=$1", [adminDocument])).rows[0].deleted_at, null, "role downgrade race must not soft-delete metadata");
    await pool.query("update users set role='admin' where id=$1", [roleRaceAdmin.id]);

    // A session can expire while actor-row locking waits; expiry must be rechecked after locks are acquired.
    const expiryBlocker = await pool.connect();
    let pendingExpiryPatch;
    try {
      await expiryBlocker.query("begin");
      await expiryBlocker.query("select id from users where id=$1 for update", [roleRaceLawyer.id]);
      await pool.query("update auth_sessions set expires_at=clock_timestamp()+interval '2 seconds' where token_hash=$1", [lawyerTokenHash]);
      const expiryTitle = (await pool.query("select title from case_documents where id=$1", [idsByLevel.normal])).rows[0].title;
      const expiryAuditCount = (await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1", [idsByLevel.normal])).rows[0].count;
      pendingExpiryPatch = request("/api/case-documents/" + idsByLevel.normal, { token: roleRaceLawyer.token, csrf: roleRaceLawyer.csrf, method: "PATCH", portToUse: rolePort, body: { title: "must not update after expiry while waiting for lock" } });
      await waitForRoleHeartbeat();
      await waitForActorLockWait();
      await delay(2200);
      await expiryBlocker.query("commit");
      const expiredWhileWaiting = await pendingExpiryPatch;
      assert.equal(expiredWhileWaiting.status, 401, "write must reject a session that expires while actor row locks are waiting");
      assert.deepEqual(expiredWhileWaiting.body, { error: "authentication_required" });
      assert.equal((await pool.query("select title from case_documents where id=$1", [idsByLevel.normal])).rows[0].title, expiryTitle, "expired session must not mutate document metadata");
      assert.equal((await pool.query("select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1", [idsByLevel.normal])).rows[0].count, expiryAuditCount, "expired request must not add an audit event");
    } finally {
      await expiryBlocker.query("rollback").catch(()=>{});
      expiryBlocker.release();
      if (pendingExpiryPatch) await pendingExpiryPatch.catch(()=>{});
      await pool.query("update auth_sessions set expires_at=clock_timestamp()+interval '1 hour' where token_hash=$1", [lawyerTokenHash]);
    }
  } finally {
    await pool.query("drop trigger delay_lawyer_session_heartbeat_trigger on auth_sessions").catch(()=>{});
    await pool.query("drop function delay_lawyer_session_heartbeat()").catch(()=>{});
    await pool.query("update users set role='lawyer' where id=$1",[roleRaceLawyer.id]);
  }
  for (const account of roleAccounts) {
    const list=await request("/api/case-documents",{token:account.token,csrf:account.csrf,portToUse:rolePort});
    assert.equal(list.status,200);
    for(const level of ["normal","confidential","restricted"]){
      const expected=readable[account.role].includes(level);
      assert.equal(list.body.data.some(d=>d.id===idsByLevel[level]),expected,`${account.role} list policy for ${level}`);
      const detail=await request(`/api/case-documents/${idsByLevel[level]}`,{token:account.token,csrf:account.csrf,portToUse:rolePort});
      assert.equal(detail.status,expected?200:404,`${account.role} detail policy for ${level}`);
      if(!expected)assert.deepEqual(detail.body,{error:"document_not_found"});
    }
  }
  const roleCreatedDocuments=new Map();
  for(const account of roleAccounts){
    const result=await request("/api/case-documents",{token:account.token,csrf:account.csrf,method:"POST",portToUse:rolePort,body:{case_id:ids.caseA,title:`Role policy create ${account.role}`,confidentiality:"normal"}});
    if(["owner","admin","lawyer","assistant"].includes(account.role)){assert.equal(result.status,201);roleCreatedDocuments.set(account.role,result.body.data.id);}
    else {assert.equal(result.status,403);assert.deepEqual(result.body,{error:"document_role_forbidden"});}
  }
  const assistant=roleAccounts.find(a=>a.role==="assistant");
  const deniedCreate=await request("/api/case-documents",{token:assistant.token,csrf:assistant.csrf,method:"POST",portToUse:rolePort,body:{case_id:ids.caseA,title:"Denied restricted assistant create",confidentiality:"restricted"}});
  assert.equal(deniedCreate.status,403);assert.deepEqual(deniedCreate.body,{error:"document_confidentiality_forbidden"});
  assert.equal((await pool.query("select count(*)::int as count from case_documents where title='Denied restricted assistant create'")).rows[0].count,0);
  const replayKey="assistant-confidential-replay-01";
  const replayCreate=await request("/api/case-documents",{token:assistant.token,csrf:assistant.csrf,method:"POST",portToUse:rolePort,idempotencyKey:replayKey,body:{case_id:ids.caseA,title:"Replay becomes restricted",confidentiality:"confidential"}});
  assert.equal(replayCreate.status,201,"assistant can initially create confidential document");
  const replayDocId=replayCreate.body.data.id;
  const elevateReplayDoc=await request(`/api/case-documents/${replayDocId}`,{token:tokenA,csrf:csrfA,method:"PATCH",portToUse:rolePort,body:{confidentiality:"restricted"}});
  assert.equal(elevateReplayDoc.status,200,"owner can elevate document classification");
  const deniedReplay=await request("/api/case-documents",{token:assistant.token,csrf:assistant.csrf,method:"POST",portToUse:rolePort,idempotencyKey:replayKey,body:{case_id:ids.caseA,title:"Replay becomes restricted",confidentiality:"confidential"}});
  assert.equal(deniedReplay.status,404,"idempotency replay must not bypass restricted read policy");
  assert.deepEqual(deniedReplay.body,{error:"document_not_found"});
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1",[replayDocId])).rows[0].confidentiality,"restricted",
    "denied idempotency replay must not change classification");

  // Hold the document row lock while a concurrent replay starts. The replay must wait
  // for the committed classification and must not read the stale confidential level.
  const restoreReplayDoc=await request(`/api/case-documents/${replayDocId}`,{token:tokenA,csrf:csrfA,method:"PATCH",portToUse:rolePort,body:{confidentiality:"confidential"}});
  assert.equal(restoreReplayDoc.status,200,"owner can restore confidential level for race fixture");
  const classificationLock=await pool.connect();
  let concurrentReplay;
  try {
    await classificationLock.query("begin");
    await classificationLock.query("update case_documents set confidentiality='restricted' where id=$1",[replayDocId]);
    concurrentReplay=request("/api/case-documents",{token:assistant.token,csrf:assistant.csrf,method:"POST",portToUse:rolePort,idempotencyKey:replayKey,body:{case_id:ids.caseA,title:"Replay becomes restricted",confidentiality:"confidential"}});
    const earlyResult=await Promise.race([concurrentReplay.then(result=>({finished:true,result})),delay(150).then(()=>({finished:false}))]);
    assert.equal(earlyResult.finished,false,"idempotency replay must block on the in-flight classification update");
    await classificationLock.query(
      "insert into audit_logs(office_id,user_id,action,entity_type,entity_id,metadata) values($1,$2,'update','case_document',$3,$4)",
      [ids.officeA,ids.userA,replayDocId,JSON.stringify({confidentiality_change:{from:"confidential",to:"restricted"},test_fixture:true})]
    );
    await classificationLock.query("commit");
    const racedReplay=await concurrentReplay;
    assert.equal(racedReplay.status,404,"replay must be denied after concurrent restricted classification commits");
    assert.deepEqual(racedReplay.body,{error:"document_not_found"});
    const raceState=await pool.query("select confidentiality from case_documents where id=$1",[replayDocId]);
    assert.equal(raceState.rows[0].confidentiality,"restricted","concurrent replay must not alter classification");
    const raceAudit=await pool.query("select metadata from audit_logs where entity_type='case_document' and entity_id=$1 and action='update' and metadata->>'test_fixture'='true'",[replayDocId]);
    assert.equal(raceAudit.rowCount,1,"classification state and its audit event must commit atomically in the race fixture");
    assert.deepEqual(raceAudit.rows[0].metadata.confidentiality_change,{from:"confidential",to:"restricted"});
  } finally {
    if(concurrentReplay) await concurrentReplay.catch(()=>{});
    await classificationLock.query("rollback").catch(()=>{});
    classificationLock.release();
  }
  const assistantConfidentialCreate=await request("/api/case-documents",{token:assistant.token,csrf:assistant.csrf,method:"POST",portToUse:rolePort,body:{case_id:ids.caseA,title:"Assistant confidential create allowed",confidentiality:"confidential"}});
  assert.equal(assistantConfidentialCreate.status,201,"assistant may create confidential documents");
  const lawyer=roleAccounts.find(a=>a.role==="lawyer");
  const lawyerRestrictedCreate=await request("/api/case-documents",{token:lawyer.token,csrf:lawyer.csrf,method:"POST",portToUse:rolePort,body:{case_id:ids.caseA,title:"Lawyer restricted create allowed",confidentiality:"restricted"}});
  assert.equal(lawyerRestrictedCreate.status,201,"lawyer may create restricted documents");
  const assistantConfidentialEdit=await request(`/api/case-documents/${idsByLevel.confidential}`,{token:assistant.token,csrf:assistant.csrf,method:"PATCH",portToUse:rolePort,body:{description:"assistant may edit confidential metadata"}});
  assert.equal(assistantConfidentialEdit.status,200,"assistant may edit confidential metadata");
  const assistantRestrictedEdit=await request(`/api/case-documents/${idsByLevel.restricted}`,{token:assistant.token,csrf:assistant.csrf,method:"PATCH",portToUse:rolePort,body:{description:"must not edit restricted metadata"}});
  assert.equal(assistantRestrictedEdit.status,404,"assistant must not edit restricted metadata");
  assert.equal((await pool.query("select description from case_documents where id=$1",[idsByLevel.restricted])).rows[0].description,null,
    "denied assistant update must not mutate restricted metadata");
  for(const level of ["confidential","restricted"]){
    for(const account of roleAccounts){
      const result=await request(`/api/case-documents/${idsByLevel[level]}`,{
        token:account.token,csrf:account.csrf,method:"PATCH",portToUse:rolePort,
        body:{description:`matrix edit ${account.role} ${level}`}
      });
      const expected=["owner","admin","lawyer"].includes(account.role) ||
        (account.role==="assistant"&&level==="confidential");
      assert.equal(result.status,expected?200:(account.role==="assistant"?404:403),
        `${account.role} edit policy for ${level}`);
      if(!expected){
        const stored=(await pool.query("select description from case_documents where id=$1",[idsByLevel[level]])).rows[0].description;
        assert.notEqual(stored,`matrix edit ${account.role} ${level}`,
          `denied ${account.role} edit must not mutate ${level} metadata`);
      }
    }
  }
  for(const account of roleAccounts){
    const result=await request(`/api/case-documents/${idsByLevel.normal}`,{token:account.token,csrf:account.csrf,method:"PATCH",portToUse:rolePort,body:{description:`updated by ${account.role}`}});
    if(["owner","admin","lawyer","assistant"].includes(account.role))assert.equal(result.status,200,`${account.role} may edit normal`);
    else {assert.equal(result.status,403);assert.deepEqual(result.body,{error:"document_role_forbidden"});}
  }
  for(const role of ["lawyer","assistant"]){
    const account=roleAccounts.find(a=>a.role===role);
    const result=await request(`/api/case-documents/${idsByLevel.normal}`,{token:account.token,csrf:account.csrf,method:"PATCH",portToUse:rolePort,body:{confidentiality:"restricted"}});
    assert.equal(result.status,403);assert.deepEqual(result.body,{error:"document_confidentiality_forbidden"});
  }
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1",[idsByLevel.normal])).rows[0].confidentiality,"normal");
  const noCsrfClassificationChange=await request(`/api/case-documents/${idsByLevel.normal}`,{token:tokenA,csrf:csrfA,method:"PATCH",csrfHeader:false,portToUse:rolePort,body:{confidentiality:"confidential"}});
  assert.equal(noCsrfClassificationChange.status,403,"classification change without CSRF must be rejected");
  assert.deepEqual(noCsrfClassificationChange.body,{error:"csrf_token_required"});
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1",[idsByLevel.normal])).rows[0].confidentiality,"normal",
    "missing-CSRF classification change must not mutate stored level");
  const ownerChange=await request(`/api/case-documents/${idsByLevel.normal}`,{token:tokenA,csrf:csrfA,method:"PATCH",portToUse:rolePort,body:{confidentiality:"confidential"}});
  assert.equal(ownerChange.status,200);
  let audit=(await pool.query("select metadata from audit_logs where entity_type='case_document' and entity_id=$1 and action='update' order by created_at desc limit 1",[idsByLevel.normal])).rows[0].metadata;
  assert.deepEqual(audit.confidentiality_change,{from:"normal",to:"confidential"});
  const admin=roleAccounts.find(a=>a.role==="admin");
  const adminChange=await request(`/api/case-documents/${idsByLevel.normal}`,{token:admin.token,csrf:admin.csrf,method:"PATCH",portToUse:rolePort,body:{confidentiality:"restricted"}});
  assert.equal(adminChange.status,200);
  audit=(await pool.query("select metadata from audit_logs where entity_type='case_document' and entity_id=$1 and action='update' order by created_at desc limit 1",[idsByLevel.normal])).rows[0].metadata;
  assert.deepEqual(audit.confidentiality_change,{from:"confidential",to:"restricted"});

  // Deterministic two-PATCH race: hold the row lock, queue PATCH 1 then PATCH 2,
  // and release only after PostgreSQL reports both API statements waiting on that row.
  const concurrentClassDoc=await request("/api/case-documents",{
    token:admin.token,csrf:admin.csrf,method:"POST",portToUse:rolePort,
    body:{case_id:ids.caseA,title:"Concurrent confidentiality PATCH audit chain",confidentiality:"normal"}
  });
  assert.equal(concurrentClassDoc.status,201,"race fixture document should be created");
  const concurrentClassId=concurrentClassDoc.body.data.id;
  const classificationBlocker=await pool.connect();
  let firstClassPatch,secondClassPatch;
  const waitForBlockedPatchCount=async expected=>{
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      const waiting=await pool.query(
        "select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'select case_id,confidentiality from case_documents%'"
      );
      if(waiting.rows[0].count>=expected)return;
      await delay(25);
    }
    throw new Error(`Timed out waiting for ${expected} blocked classification PATCH query/queries`);
  };
  try{
    await classificationBlocker.query("begin");
    await classificationBlocker.query("select id from case_documents where id=$1 for update",[concurrentClassId]);
    firstClassPatch=request(`/api/case-documents/${concurrentClassId}`,{
      token:tokenA,csrf:csrfA,method:"PATCH",portToUse:rolePort,body:{confidentiality:"confidential"}
    });
    await waitForBlockedPatchCount(1);
    secondClassPatch=request(`/api/case-documents/${concurrentClassId}`,{
      token:admin.token,csrf:admin.csrf,method:"PATCH",portToUse:rolePort,body:{confidentiality:"restricted"}
    });
    await waitForBlockedPatchCount(2);
    // Both API transactions have started before this marker while their row-lock query is blocked.
    // created_at based on transaction_timestamp()/now() would predate this marker.
    const lockReleaseMarkerUs=(await pool.query("select floor(extract(epoch from clock_timestamp()) * 1000000)::bigint::text as released_at_us")).rows[0].released_at_us;
    await classificationBlocker.query("commit");
    const [firstClassResult,secondClassResult]=await Promise.all([firstClassPatch,secondClassPatch]);
    assert.equal(firstClassResult.status,200,"first queued classification PATCH must succeed");
    assert.equal(firstClassResult.body.data.confidentiality,"confidential","first PATCH must apply its requested level");
    assert.equal(secondClassResult.status,200,"second queued classification PATCH must succeed");
    assert.equal(secondClassResult.body.data.confidentiality,"restricted","second PATCH must apply after first");
    const classificationState=await pool.query("select confidentiality from case_documents where id=$1",[concurrentClassId]);
    assert.equal(classificationState.rows[0].confidentiality,"restricted","final state must match the second serialized PATCH");
    const classificationEvents=await pool.query(
      "select metadata,created_at,floor(extract(epoch from created_at) * 1000000)::bigint::text as created_at_us from audit_logs where entity_type='case_document' and entity_id=$1 and action='update' and metadata ? 'confidentiality_change' order by created_at asc",
      [concurrentClassId]
    );
    assert.equal(classificationEvents.rowCount,2,"both committed classification changes must have exactly one audit event each");
    assert.deepEqual(classificationEvents.rows.map(row=>row.metadata.confidentiality_change),[
      {from:"normal",to:"confidential"},
      {from:"confidential",to:"restricted"}
    ],"concurrent audit events must form the actual serialized from→to chain");
    assert.ok(new Date(classificationEvents.rows[0].created_at)<new Date(classificationEvents.rows[1].created_at),
      "audit timestamps must follow the serialized classification order, not transaction start time");
    assert.ok(classificationEvents.rows.every(row=>BigInt(row.created_at_us)>BigInt(lockReleaseMarkerUs)),
      "audit timestamps must record event insertion after the lock releases, not earlier transaction start time (microsecond precision)");
    console.log("PASS: concurrent confidentiality PATCHes serialize and preserve audit transition/timestamp order");
  } finally {
    await classificationBlocker.query("rollback").catch(()=>{});
    classificationBlocker.release();
    if(firstClassPatch) await firstClassPatch.catch(()=>{});
    if(secondClassPatch) await secondClassPatch.catch(()=>{});
  }

  for(const role of ["lawyer","assistant","viewer"]){
    const account=roleAccounts.find(a=>a.role===role);
    const result=await request(`/api/case-documents/${idsByLevel.normal}`,{token:account.token,csrf:account.csrf,method:"DELETE",portToUse:rolePort});
    assert.equal(result.status,403);assert.deepEqual(result.body,{error:"document_role_forbidden"});
  }
  for(const role of ["owner","admin"]){
    const account=roleAccounts.find(a=>a.role===role);
    const result=await request(`/api/case-documents/${roleCreatedDocuments.get(role)}`,{token:account.token,csrf:account.csrf,method:"DELETE",portToUse:rolePort});
    assert.equal(result.status,204);
  }
  console.log("PASS: confidentiality policy, role matrix, non-disclosure, rejected mutations and classification audit");

  console.log("PASS: office A can read its own document");
  console.log("PASS: office B list does not disclose office A document");
  console.log("PASS: case_id filters work without SQL errors");
  console.log("PASS: untrusted Origin, missing CSRF, and impossible date are rejected");
  console.log("PASS: successful create/update are audited once");
  console.log("PASS: audit failures roll back update and soft delete");
  console.log("PASS: soft-deleted document is hidden and audited once");

  // Deleting the parent case hides its documents from every document read path.
  const lifecycleCase = await request("/api/cases", {
    token: tokenA, csrf: csrfA, method: "POST",
    body: { client_id: clientA, case_number: "A-DOC-LIFECYCLE", title: "Case document lifecycle fixture" }
  });
  assert.equal(lifecycleCase.status, 201, "case lifecycle fixture should be created");
  const lifecycleCaseId = lifecycleCase.body.data.id;
  // Seed the child row directly so this lifecycle-only assertion does not consume
  // the independent HTTP create-rate-limit budget used by later API regression tests.
  const lifecycleDocInsert = await pool.query(
    "insert into case_documents(office_id,case_id,title,created_by,updated_by) values($1,$2,$3,$4,$4) returning id",
    [ids.officeA, lifecycleCaseId, "Hidden when parent case is deleted", ids.userA]
  );
  const lifecycleDocId = lifecycleDocInsert.rows[0].id;
  const deleteParentCase = await request(`/api/cases/${lifecycleCaseId}`, {
    token: tokenA, csrf: csrfA, method: "DELETE"
  });
  assert.equal(deleteParentCase.status, 204, "parent case should soft-delete");
  const parentDeletedDocDetail = await request(`/api/case-documents/${lifecycleDocId}`, { token: tokenA, csrf: csrfA });
  assert.equal(parentDeletedDocDetail.status, 404, "document detail must hide documents whose parent case is soft-deleted");
  const parentDeletedDocList = await request("/api/case-documents", { token: tokenA, csrf: csrfA });
  assert.equal(parentDeletedDocList.body.data.some(row => row.id === lifecycleDocId), false,
    "document list must hide documents whose parent case is soft-deleted");
  const parentDeletedState = await pool.query(
    "select d.deleted_at, c.deleted_at as case_deleted_at from case_documents d join cases c on c.id=d.case_id and c.office_id=d.office_id where d.id=$1",
    [lifecycleDocId]
  );
  assert.ok(parentDeletedState.rows[0].case_deleted_at, "parent case should remain soft-deleted");
  assert.equal(parentDeletedState.rows[0].deleted_at, null,
    "case deletion must not silently mutate document lifecycle state");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where entity_type='case_document' and entity_id=$1",
    [lifecycleDocId]
  )).rows[0].count, 0, "parent case deletion must not fabricate a document audit event");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where entity_type='case' and entity_id=$1 and action='delete'",
    [lifecycleCaseId]
  )).rows[0].count, 1, "parent case deletion must create exactly one case delete audit event");
  console.log("PASS: parent case soft deletion hides linked documents without falsifying document audit history");
  console.log("PASS: title and size boundary inputs are rejected");
  console.log("PASS: database connection outage returns sanitized 503");
  console.log("PASS: oversized JSON receives a sanitized 413 response");
  console.log("PASS: repeated soft delete does not duplicate audit events");
  console.log("PASS: concurrent update/delete requests remain consistent with exactly one delete audit");
  console.log("PASS: database statement timeout rolls back mutation and returns sanitized error");
  assert.equal(serverOutput.includes("forced audit failure"), false, "server logs must not include raw database exception messages");
  assert.equal(auditServerOutput.includes("forced audit failure"), false, "audit rollback server logs must not expose raw database exceptions");
  assert.equal(serverOutput.includes("statement timeout"), false, "server logs must not include raw statement timeout details");
  assert.equal(timeoutServerOutput.includes("statement timeout"), false, "timeout-server logs must not disclose raw database errors");
  console.log("PASS: authentication and CSRF negatives are rejected with generic responses");
  console.log("PASS: server logs omit raw database exception details");
  console.log("PASS: cross-office read rejected");
  console.log("PASS: cross-office update rejected without mutation");
  console.log("PASS: cross-office delete rejected without mutation");

  const rateLimitPort = port + 3;
  rateLimitServer = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(rateLimitPort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"]
  });
  rateLimitServer.stdout.on("data", chunk => { rateLimitServerOutput += chunk.toString(); });
  rateLimitServer.stderr.on("data", chunk => { rateLimitServerOutput += chunk.toString(); });
  await waitForServer(rateLimitPort);

  let rateLimited = false;
  for (let i = 0; i < 21; i++) {
    const limited = await request("/api/case-documents", {
      token: tokenA, csrf: csrfA, method: "POST",
      idempotencyKey: `rate-limit-key-${String(i).padStart(2,"0")}`,
      // Spoofed forwarding headers must not let a direct client rotate its limiter identity.
      extraHeaders: { "x-forwarded-for": `198.51.100.${i + 1}` },
      body: {},
      portToUse: rateLimitPort
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

  const logoutToken = "test-session-logout-".padEnd(48, "e");
  const logoutCsrf = "test-csrf-logout-".padEnd(48, "f");
  await pool.query("insert into auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) values ($1,$2,$3,$4,now()+interval '1 hour')", [ids.userA, ids.officeA, hash(logoutToken), hash(logoutCsrf)]);
  const revokedReplayFixture = (await pool.query(
    "insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Session revocation replay','evidence',$3,$3) returning id",
    [ids.officeA, ids.caseA, ids.userA]
  )).rows[0].id;
  const revokedReplayKey = "revoked-session-replay-01";
  const revokedReplayPayload = { title: "Committed before logout" };
  const beforeLogoutWrite = await request("/api/case-documents/" + revokedReplayFixture, {
    token: logoutToken, csrf: logoutCsrf, method: "PATCH", idempotencyKey: revokedReplayKey, body: revokedReplayPayload
  });
  assert.equal(beforeLogoutWrite.status, 200, "live session must be able to commit the keyed mutation before logout");
  const beforeLogoutAuditCount = (await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, revokedReplayFixture]
  )).rows[0].count;
  const beforeLogoutKeyCount = (await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, revokedReplayKey]
  )).rows[0].count;
  const logout = await request("/api/auth/logout", { token: logoutToken, csrf: logoutCsrf, method: "POST" });
  assert.equal(logout.status, 200, "valid logout must succeed");
  assert.deepEqual(logout.body, { ok: true });
  assert.match(logout.headers["set-cookie"] || "", /Max-Age=0/, "logout must clear browser authentication cookies");
  const revokedRow = await pool.query("select revoked_at from auth_sessions where token_hash=$1", [hash(logoutToken)]);
  assert.ok(revokedRow.rows[0].revoked_at, "logout must revoke the server-side session");
  const afterLogout = await request("/api/case-documents", { token: logoutToken, csrf: logoutCsrf });
  assert.equal(afterLogout.status, 401, "revoked session must not authorize subsequent requests");
  assert.deepEqual(afterLogout.body, { error: "authentication_required" });
  const revokedReplay = await request("/api/case-documents/" + revokedReplayFixture, {
    token: logoutToken, csrf: logoutCsrf, method: "PATCH", idempotencyKey: revokedReplayKey, body: revokedReplayPayload
  });
  assert.equal(revokedReplay.status, 401, "revoked session must not replay a previously committed idempotent mutation");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, revokedReplayKey])).rows[0].count, beforeLogoutKeyCount, "revoked replay must not change the durable idempotency row");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, revokedReplayFixture])).rows[0].count, beforeLogoutAuditCount, "revoked replay must not add audit rows");
  assert.equal((await pool.query("select title from case_documents where id=$1", [revokedReplayFixture])).rows[0].title,
    "Committed before logout", "revoked replay must not repeat or alter the committed mutation");
  console.log("PASS: logout clears cookies, revokes session, rejects subsequent requests and blocks idempotent replay");


  // Deterministic race: authorization has passed and the transaction is paused
  // in the document UPDATE when logout revokes the session. An in-flight request may
  // linearize before revocation (200) or be rejected (401); either way its DB effects
  // must be atomic and any later replay must fail authentication.
  const raceSessionToken = "test-session-revoke-race-".padEnd(48, "g");
  const raceSessionCsrf = "test-csrf-revoke-race-".padEnd(48, "h");
  await pool.query("insert into auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')",
    [ids.userA, ids.officeA, hash(raceSessionToken), hash(raceSessionCsrf)]);
  const revokeRaceDoc = (await pool.query(
    "insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Before session race','evidence',$3,$3) returning id",
    [ids.officeA, ids.caseA, ids.userA]
  )).rows[0].id;
  const revokeRaceKey = "session-revoke-race-01";
  await pool.query(`
    create or replace function pause_session_revoke_race() returns trigger language plpgsql as $fn$
    begin
      if new.id = '${revokeRaceDoc}'::uuid and new.title = 'Mutation raced with logout' then perform pg_sleep(3); end if;
      return new;
    end;
    $fn$;
    create trigger pause_session_revoke_race_trigger before update on case_documents
      for each row execute function pause_session_revoke_race();
  `);
  const racePatchPromise = request("/api/case-documents/" + revokeRaceDoc, {
    token: raceSessionToken, csrf: raceSessionCsrf, method: "PATCH", idempotencyKey: revokeRaceKey,
    body: { title: "Mutation raced with logout" }
  }).catch(() => ({ status: 0, body: null }));
  const raceDeadline = Date.now() + 8000;
  let raceBackendPid = null;
  while (Date.now() < raceDeadline) {
    const active = await pool.query("select pid from pg_stat_activity where datname=current_database() and wait_event='PgSleep' and query ilike '%update case_documents%'");
    if (active.rowCount) { raceBackendPid = active.rows[0].pid; break; }
    await delay(25);
  }
  assert.ok(raceBackendPid, "PATCH must reach the controlled pause before logout");
  const raceLogout = await request("/api/auth/logout", { token: raceSessionToken, csrf: raceSessionCsrf, method: "POST" });
  assert.equal(raceLogout.status, 200, "logout must revoke the session during the in-flight request");
  const racePatch = await racePatchPromise;
  assert.ok([200,401].includes(racePatch.status), "racing request must have a defined authorization outcome");
  assert.ok((await pool.query("select revoked_at from auth_sessions where token_hash=$1", [hash(raceSessionToken)])).rows[0].revoked_at,
    "logout must remain durable after the race");
  const raceDocState = (await pool.query("select title from case_documents where id=$1", [revokeRaceDoc])).rows[0].title;
  const raceKeyRows = await pool.query("select response_status from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, revokeRaceKey]);
  const raceAuditRows = await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, revokeRaceDoc]);
  if (racePatch.status === 200) {
    assert.equal(raceDocState, "Mutation raced with logout");
    assert.equal(raceKeyRows.rowCount, 1);
    assert.equal(raceKeyRows.rows[0].response_status, 200);
    assert.equal(raceAuditRows.rows[0].count, 1, "successful in-flight request must have exactly one audit event");
  } else {
    assert.equal(raceDocState, "Before session race");
    assert.equal(raceKeyRows.rowCount, 0, "rejected in-flight request must not leave an idempotency reservation");
    assert.equal(raceAuditRows.rows[0].count, 0, "rejected in-flight request must not write audit");
  }
  const raceReplayAfterLogout = await request("/api/case-documents/" + revokeRaceDoc, {
    token: raceSessionToken, csrf: raceSessionCsrf, method: "PATCH", idempotencyKey: revokeRaceKey,
    body: { title: "Mutation raced with logout" }
  });
  assert.equal(raceReplayAfterLogout.status, 401, "replay after logout must be denied regardless of in-flight ordering");
  await pool.query("drop trigger pause_session_revoke_race_trigger on case_documents");
  await pool.query("drop function pause_session_revoke_race()");
  console.log("PASS: in-flight mutation/logout race has atomic DB outcome and every post-logout replay is rejected");

  // The earlier expired-session scenario intentionally expires tokenA; restore this
  // synthetic test-only session before the isolated crash/retry case.
  await pool.query("update auth_sessions set expires_at=now()+interval '1 hour', revoked_at=null where token_hash=$1 and user_id=$2 and office_id=$3",
    [hash(tokenA), ids.userA, ids.officeA]);

  // Kill a dedicated API process while a row trigger pauses the PATCH after its
  // idempotency reservation but before the document UPDATE completes. This avoids
  // depending on audit INSERT query text and proves uncommitted reservations vanish.
  const interruptedFixture = (await pool.query(
    "insert into case_documents(office_id,case_id,title,document_type,created_by,updated_by) values($1,$2,'Before interrupted transaction','evidence',$3,$3) returning id",
    [ids.officeA, ids.caseA, ids.userA]
  )).rows[0].id;
  const interruptedKey = "process-interrupt-01";
  await pool.query(`
    create or replace function pause_interrupted_document_update() returns trigger language plpgsql as $fn$
    begin
      if new.id = '${interruptedFixture}'::uuid and new.title = 'Must roll back after process termination' then
        perform pg_sleep(30);
      end if;
      return new;
    end;
    $fn$;
    create trigger pause_interrupted_document_update_trigger
      before update on case_documents for each row execute function pause_interrupted_document_update();
  `);
  const crashPort = port + 7;
  crashServer = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(crashPort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin, RATE_LIMIT_MODE: "memory" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  crashServer.stdout.on("data", chunk => { crashServerOutput += chunk.toString(); });
  crashServer.stderr.on("data", chunk => { crashServerOutput += chunk.toString(); });
  await waitForServer(crashPort);
  const interruptedRequest = request("/api/case-documents/" + interruptedFixture, {
    token: tokenA, csrf: csrfA, method: "PATCH", idempotencyKey: interruptedKey,
    body: { title: "Must roll back after process termination" }, portToUse: crashPort
  }).catch(() => null);
  const waitForUpdatePause = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const active = await pool.query(
        "select pid from pg_stat_activity where datname=current_database() and wait_event='PgSleep' and query ilike '%update case_documents%'"
      );
      if (active.rowCount > 0) return active.rows[0].pid;
      await delay(25);
    }
    throw new Error("Timed out waiting for transaction to reach the document trigger after idempotency reservation");
  };
  const interruptedBackendPid = await waitForUpdatePause();
  const crashExit = new Promise(resolve => crashServer.once("exit", resolve));
  crashServer.kill("SIGKILL");
  await crashExit;
  await interruptedRequest;
  // PostgreSQL may finish an in-flight statement before noticing the dead client;
  // terminate this known disposable test backend explicitly to force transaction abort.
  await pool.query("select pg_terminate_backend($1)", [interruptedBackendPid]);
  const waitForBackendRollback = async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const active = await pool.query("select count(*)::int as count from pg_stat_activity where pid=$1", [interruptedBackendPid]);
      if (active.rows[0].count === 0) return;
      await delay(25);
    }
    throw new Error("PostgreSQL backend did not exit after API process termination");
  };
  await waitForBackendRollback();
  assert.equal((await pool.query("select title from case_documents where id=$1", [interruptedFixture])).rows[0].title,
    "Before interrupted transaction", "process termination before COMMIT must roll back the document mutation");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, interruptedKey])).rows[0].count, 0, "process interruption must not leave an incomplete idempotency reservation");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2",
    [ids.officeA, interruptedFixture])).rows[0].count, 0, "process interruption must not leave a partial audit event");
  await pool.query("drop trigger pause_interrupted_document_update_trigger on case_documents");
  await pool.query("drop function pause_interrupted_document_update()");
  const interruptedRetry = await request("/api/case-documents/" + interruptedFixture, {
    token: tokenA, csrf: csrfA, method: "PATCH", idempotencyKey: interruptedKey,
    body: { title: "Must roll back after process termination" }
  });
  assert.equal(interruptedRetry.status, 200, "same key must be reusable after PostgreSQL rolls back the killed connection");
  assert.equal((await pool.query("select title from case_documents where id=$1", [interruptedFixture])).rows[0].title,
    "Must roll back after process termination");
  const interruptedIdempotency = await pool.query("select response_status from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, interruptedKey]);
  assert.equal(interruptedIdempotency.rowCount, 1, "retry after interruption must persist one idempotency record");
  assert.equal(interruptedIdempotency.rows[0].response_status, 200, "idempotency record must be completed, not left NULL");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2 and action='update'",
    [ids.officeA, interruptedFixture])).rows[0].count, 1, "retry after process interruption must write exactly one audit event");
  console.log("PASS: killing API process before COMMIT rolls back mutation and idempotency reservation; same-key retry commits one complete record and audit");

  // Soft-delete and child-write races must serialize on the referenced parent.
  // Use distinct actors so lockLiveMutationActor's session/user locks do not
  // serialize the requests before they reach the business parent row.
  const makeRaceActor = async (label) => {
    const userId = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");
    const csrf = crypto.randomBytes(24).toString("hex");
    await pool.query(
      "insert into users(id,office_id,full_name,email,role) values($1,$2,$3,$4,'owner')",
      [userId, ids.officeA, "Soft-delete race " + label, userId + "@race.example.test"]
    );
    await pool.query(
      "insert into auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) values($1,$2,$3,$4,now()+interval '1 hour')",
      [userId, ids.officeA, hash(token), hash(csrf)]
    );
    return { userId, token, csrf };
  };
  const raceActors = {};
  for (const label of ["client-delete","case-create","case-patch","case-delete","hearing-create","action-create","hearing-patch","action-patch","document-create","document-patch"]) {
    raceActors[label] = await makeRaceActor(label);
  }
  const waitForLockWait = async (pattern, expectedCount, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const waiting = await pool.query(
        "select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike $1",
        [pattern]
      );
      if (waiting.rows[0].count >= expectedCount) return;
      await delay(20);
    }
    const last = await pool.query(
      "select pid,wait_event_type,wait_event,left(query,240) as query from pg_stat_activity where datname=current_database() and wait_event_type='Lock'"
    );
    assert.fail(`${label}: expected ${expectedCount} lock waiter(s) for ${pattern}; current waits: ${JSON.stringify(last.rows)}`);
  };
  const auditCount = async (entityType, action) => Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and action=$3",
    [ids.officeA, entityType, action]
  )).rows[0].count);

  // Case reassignment vs soft-delete of its OLD client. The two fixtures deliberately
  // invert UUID ordering so the helper must lock old/new clients in sorted order,
  // not in request-specific old-then-new order.
  const reassignmentDeleteFirstOld = "10000000-0000-4000-8000-000000000101";
  const reassignmentDeleteFirstNew = "f0000000-0000-4000-8000-000000000102";
  const reassignmentDeleteFirstCase = "20000000-0000-4000-8000-000000000103";
  const reassignmentDeleteFirstNumber = "REASSIGN-DELETE-FIRST-" + crypto.randomBytes(5).toString("hex");
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Old client delete-first','8111111111',$3,$3),($4,$2,'individual','New client delete-first','8222222222',$3,$3)",
    [reassignmentDeleteFirstOld, ids.officeA, ids.userA, reassignmentDeleteFirstNew]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Must not escape deleted old client',$5,$5)",
    [reassignmentDeleteFirstCase, ids.officeA, reassignmentDeleteFirstOld, reassignmentDeleteFirstNumber, ids.userA]
  );
  const reassignmentDeleteFirstAudit = {
    clientDelete: await auditCount("client", "delete"),
    caseUpdate: await auditCount("case", "update")
  };
  const reassignmentDeleteFirstBlocker = await pool.connect();
  let reassignmentDeleteFirstBlockerOpen = false;
  let reassignmentDeleteFirstDeletePromise;
  let reassignmentDeleteFirstPatchPromise;
  try {
    await reassignmentDeleteFirstBlocker.query("begin");
    await reassignmentDeleteFirstBlocker.query("select id from clients where id=$1 for update", [reassignmentDeleteFirstOld]);
    reassignmentDeleteFirstBlockerOpen = true;
    reassignmentDeleteFirstDeletePromise = request("/api/clients/" + reassignmentDeleteFirstOld, {
      token: raceActors["client-delete"].token, csrf: raceActors["client-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update clients%deleted_at = now()%", 1, "old-client delete queued before case reassignment");
    reassignmentDeleteFirstPatchPromise = request("/api/cases/" + reassignmentDeleteFirstCase, {
      token: raceActors["case-patch"].token, csrf: raceActors["case-patch"].csrf, method: "PATCH",
      body: { client_id: reassignmentDeleteFirstNew }
    });
    await waitForLockWait("%from public.lock_live_case_reassignment%", 1, "case reassignment waits behind old-client delete");
  } finally {
    if (reassignmentDeleteFirstBlockerOpen) await reassignmentDeleteFirstBlocker.query("rollback").catch(() => {});
    reassignmentDeleteFirstBlocker.release();
  }
  const [reassignmentDeleteFirstDelete, reassignmentDeleteFirstPatch] = await Promise.all([
    reassignmentDeleteFirstDeletePromise, reassignmentDeleteFirstPatchPromise
  ]);
  assert.equal(reassignmentDeleteFirstDelete.status, 204);
  assert.equal(reassignmentDeleteFirstPatch.status, 400, "a case must not be reassigned away after its old client was soft-deleted");
  assert.deepEqual(reassignmentDeleteFirstPatch.body, { error: "invalid_related_client" });
  assert.ok((await pool.query("select deleted_at from clients where id=$1", [reassignmentDeleteFirstOld])).rows[0].deleted_at);
  assert.equal((await pool.query("select client_id from cases where id=$1", [reassignmentDeleteFirstCase])).rows[0].client_id,
    reassignmentDeleteFirstOld, "rejected reassignment preserves the original client relationship");
  assert.equal(await auditCount("client", "delete"), reassignmentDeleteFirstAudit.clientDelete + 1);
  assert.equal(await auditCount("case", "update"), reassignmentDeleteFirstAudit.caseUpdate,
    "rejected reassignment must not emit a case audit row");

  // Reverse UUID order: target client sorts before the old client. PATCH queues
  // for the old-client lock first in the sorted set; a subsequent delete queues
  // behind PATCH. PATCH commits the relationship and audit atomically, then the
  // old-client delete commits. This proves no old/new lock-order cycle is needed.
  const reassignmentPatchFirstNew = "30000000-0000-4000-8000-000000000201";
  const reassignmentPatchFirstOld = "d0000000-0000-4000-8000-000000000202";
  const reassignmentPatchFirstCase = "40000000-0000-4000-8000-000000000203";
  const reassignmentPatchFirstNumber = "REASSIGN-PATCH-FIRST-" + crypto.randomBytes(5).toString("hex");
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','New client patch-first','8333333333',$3,$3),($4,$2,'individual','Old client patch-first','8444444444',$3,$3)",
    [reassignmentPatchFirstNew, ids.officeA, ids.userA, reassignmentPatchFirstOld]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Case reassignment patch-first',$5,$5)",
    [reassignmentPatchFirstCase, ids.officeA, reassignmentPatchFirstOld, reassignmentPatchFirstNumber, ids.userA]
  );
  const reassignmentPatchFirstAudit = {
    clientDelete: await auditCount("client", "delete"),
    caseUpdate: await auditCount("case", "update")
  };
  const reassignmentPatchFirstBlocker = await pool.connect();
  let reassignmentPatchFirstBlockerOpen = false;
  let reassignmentPatchFirstDeletePromise;
  let reassignmentPatchFirstPatchPromise;
  try {
    await reassignmentPatchFirstBlocker.query("begin");
    await reassignmentPatchFirstBlocker.query("select id from clients where id=$1 for update", [reassignmentPatchFirstOld]);
    reassignmentPatchFirstBlockerOpen = true;
    reassignmentPatchFirstPatchPromise = request("/api/cases/" + reassignmentPatchFirstCase, {
      token: raceActors["case-patch"].token, csrf: raceActors["case-patch"].csrf, method: "PATCH",
      body: { client_id: reassignmentPatchFirstNew }
    });
    await waitForLockWait("%from public.lock_live_case_reassignment%", 1, "case reassignment holds target lock and waits for old client");
    reassignmentPatchFirstDeletePromise = request("/api/clients/" + reassignmentPatchFirstOld, {
      token: raceActors["client-delete"].token, csrf: raceActors["client-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update clients%deleted_at = now()%", 1, "old-client delete queues behind reassignment");
  } finally {
    if (reassignmentPatchFirstBlockerOpen) await reassignmentPatchFirstBlocker.query("rollback").catch(() => {});
    reassignmentPatchFirstBlocker.release();
  }
  const [reassignmentPatchFirstPatch, reassignmentPatchFirstDelete] = await Promise.all([
    reassignmentPatchFirstPatchPromise, reassignmentPatchFirstDeletePromise
  ]);
  assert.equal(reassignmentPatchFirstPatch.status, 200, "PATCH queued before old-client delete should commit");
  assert.equal(reassignmentPatchFirstDelete.status, 204, "old-client delete should proceed after reassignment releases its locks");
  assert.equal((await pool.query("select client_id from cases where id=$1", [reassignmentPatchFirstCase])).rows[0].client_id,
    reassignmentPatchFirstNew, "successful reassignment must persist the new same-office client link");
  assert.ok((await pool.query("select deleted_at from clients where id=$1", [reassignmentPatchFirstOld])).rows[0].deleted_at);
  assert.equal(await auditCount("client", "delete"), reassignmentPatchFirstAudit.clientDelete + 1);
  assert.equal(await auditCount("case", "update"), reassignmentPatchFirstAudit.caseUpdate + 1,
    "successful reassignment must commit exactly one case audit row");
  console.log("PASS: case PATCH locks old/new clients in stable UUID order; old-client soft-delete races preserve relationships and audit atomicity");

  // Client soft-delete vs case create and case reassignment to that client.
  const raceClient = crypto.randomUUID();
  const raceCase = crypto.randomUUID();
  const raceClientCaseNumber = "SOFT-DELETE-CLIENT-" + crypto.randomBytes(5).toString("hex");
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Client parent race','9876501234',$3,$3)",
    [raceClient, ids.officeA, ids.userA]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Case to reassign',$5,$5)",
    [raceCase, ids.officeA, clientA, raceClientCaseNumber + "-SOURCE", ids.userA]
  );
  const hiddenCase = crypto.randomUUID();
  const hiddenHearing = crypto.randomUUID();
  const hiddenAction = crypto.randomUUID();
  const hiddenDocument = crypto.randomUUID();
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Case hidden by deleted client',$5,$5)",
    [hiddenCase, ids.officeA, raceClient, raceClientCaseNumber + "-DEPENDENT", ids.userA]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,now()+interval '12 days','hearing','scheduled',$4,$4)",
    [hiddenHearing, ids.officeA, hiddenCase, ids.userA]
  );
  await pool.query(
    "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values($1,$2,$3,'Action hidden by deleted client','todo','normal',$4,$4)",
    [hiddenAction, ids.officeA, hiddenCase, ids.userA]
  );
  await pool.query(
    "insert into case_documents(id,office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,$3,'Document hidden by deleted client','evidence','normal',$4,$4)",
    [hiddenDocument, ids.officeA, hiddenCase, ids.userA]
  );
  const clientDeleteAuditBefore = await auditCount("client", "delete");
  const caseCreateAuditBefore = await auditCount("case", "create");
  const caseUpdateAuditBefore = await auditCount("case", "update");
  const hearingCreateAuditBeforeClientRace = await auditCount("hearing", "create");
  const actionCreateAuditBeforeClientRace = await auditCount("case_action", "create");
  const clientBlocker = await pool.connect();
  let clientBlockerOpen = false;
  let clientDeletePromise;
  let caseCreateRacePromise;
  let casePatchRacePromise;
  let clientDeleteHearingCreateRacePromise;
  let clientDeleteActionCreateRacePromise;
  try {
    await clientBlocker.query("begin");
    await clientBlocker.query("select id from clients where id=$1 for update", [raceClient]);
    clientBlockerOpen = true;
    clientDeletePromise = request("/api/clients/" + raceClient, {
      token: raceActors["client-delete"].token, csrf: raceActors["client-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update clients%deleted_at = now()%", 1, "client delete");
    caseCreateRacePromise = request("/api/cases", {
      token: raceActors["case-create"].token, csrf: raceActors["case-create"].csrf, method: "POST",
      body: { client_id: raceClient, case_number: raceClientCaseNumber, title: "Must not attach to deleted client" }
    });
    casePatchRacePromise = request("/api/cases/" + raceCase, {
      token: raceActors["case-patch"].token, csrf: raceActors["case-patch"].csrf, method: "PATCH",
      body: { client_id: raceClient }
    });
    await waitForLockWait("%from public.lock_live_client_parent%", 1, "case create waiting for deleted target client");
    await waitForLockWait("%from public.lock_live_case_reassignment%", 1, "case reassignment waiting for deleted target client");
    clientDeleteHearingCreateRacePromise = request("/api/hearings", {
      token: raceActors["hearing-create"].token, csrf: raceActors["hearing-create"].csrf, method: "POST",
      body: { case_id: hiddenCase, hearing_at: new Date(Date.now() + 2 * 86400000).toISOString(), hearing_type: "trial", notes: "Must not create hearing after client delete" }
    });
    clientDeleteActionCreateRacePromise = request("/api/actions", {
      token: raceActors["action-create"].token, csrf: raceActors["action-create"].csrf, method: "POST",
      body: { case_id: hiddenCase, title: "Must not create action after client delete" }
    });
    await waitForLockWait("%from public.lock_live_case_parents%", 2, "hearing/action create waiting for deleted client");
  } finally {
    if (clientBlockerOpen) await clientBlocker.query("rollback").catch(() => {});
    clientBlocker.release();
  }
  const [clientDeleteRace, caseCreateRace, casePatchRace, clientDeleteHearingCreateRace, clientDeleteActionCreateRace] = await Promise.all([
    clientDeletePromise, caseCreateRacePromise, casePatchRacePromise, clientDeleteHearingCreateRacePromise, clientDeleteActionCreateRacePromise
  ]);
  assert.equal(clientDeleteRace.status, 204, "client soft-delete should win the queued parent-row race");
  assert.equal(caseCreateRace.status, 400, "case create must reject a client soft-deleted before parent lock acquisition");
  assert.deepEqual(caseCreateRace.body, { error: "invalid_related_client" });
  assert.equal(casePatchRace.status, 400, "case reassignment must reject a client soft-deleted before parent lock acquisition");
  assert.deepEqual(casePatchRace.body, { error: "invalid_related_client" });
  assert.equal(clientDeleteHearingCreateRace.status, 400, "hearing create must reject a case whose client was soft-deleted while waiting for parent locks");
  assert.deepEqual(clientDeleteHearingCreateRace.body, { error: "invalid_related_case" });
  assert.equal(clientDeleteActionCreateRace.status, 400, "action create must reject a case whose client was soft-deleted while waiting for parent locks");
  assert.deepEqual(clientDeleteActionCreateRace.body, { error: "invalid_related_case" });
  assert.ok((await pool.query("select deleted_at from clients where id=$1", [raceClient])).rows[0].deleted_at);
  assert.equal((await pool.query("select client_id from cases where id=$1", [raceCase])).rows[0].client_id, clientA,
    "failed reassignment must preserve the previous live client relationship");
  assert.equal((await pool.query("select count(*)::int as count from cases where case_number=$1", [raceClientCaseNumber])).rows[0].count, 0,
    "case create must not persist against a soft-deleted client");
  assert.equal(await auditCount("client", "delete"), clientDeleteAuditBefore + 1,
    "successful parent soft-delete must commit exactly one audit row");
  assert.equal(await auditCount("case", "create"), caseCreateAuditBefore, "rejected case create must not emit audit");
  assert.equal(await auditCount("case", "update"), caseUpdateAuditBefore, "rejected case reassignment must not emit audit");
  assert.equal(await pool.query("select count(*)::int as count from hearings where notes=$1", ["Must not create hearing after client delete"]).then(r => r.rows[0].count), 0,
    "hearing create must not persist after its client's soft-delete");
  assert.equal(await pool.query("select count(*)::int as count from case_actions where title=$1", ["Must not create action after client delete"]).then(r => r.rows[0].count), 0,
    "action create must not persist after its client's soft-delete");
  assert.equal(await auditCount("hearing", "create"), hearingCreateAuditBeforeClientRace, "rejected hearing create must not emit audit");
  assert.equal(await auditCount("case_action", "create"), actionCreateAuditBeforeClientRace, "rejected action create must not emit audit");
  console.log("PASS: client soft-delete serializes hearing/action creation; queued creates are rejected with no child rows or audit events");

  // Child-first inverse ordering: pause a hearing/action INSERT only after the API has
  // acquired the live case/client parent locks. Queue client soft-delete behind that
  // transaction, then release it. This proves the child may commit first and that the
  // queued parent deletion follows without losing the hearing summary or audit event.
  const childFirstPrefix = "CHILD-FIRST-PARENT-RACE-" + crypto.randomBytes(5).toString("hex");
  for (const childKind of ["hearing", "action"]) {
    const clientId = crypto.randomUUID();
    const caseId = crypto.randomUUID();
    const caseNumber = childFirstPrefix + "-" + childKind;
    const hearingAt = new Date(Date.now() + 6 * 86400000);
    await pool.query(
      "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual',$3,$4,$5,$5)",
      [clientId, ids.officeA, "Child-first " + childKind + " race client", "9" + String(Math.floor(Math.random() * 1000000000)).padStart(9, "0"), ids.userA]
    );
    await pool.query(
      "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,$5,null,$6,$6)",
      [caseId, ids.officeA, clientId, caseNumber, "Child-first " + childKind + " race case", ids.userA]
    );
    const auditBefore = {
      clientDelete: await auditCount("client", "delete"),
      childCreate: await auditCount(childKind === "hearing" ? "hearing" : "case_action", "create")
    };
    const blocker = await pool.connect();
    let blockerHeld = false;
    let triggerName = childKind === "hearing" ? "pause_child_first_hearing_insert" : "pause_child_first_action_insert";
    let functionName = childKind === "hearing" ? "pause_child_first_hearing_insert_fn" : "pause_child_first_action_insert_fn";
    const triggerTable = childKind === "hearing" ? "hearings" : "case_actions";
    try {
      await blocker.query("select pg_advisory_lock($1,$2)", [880001, 123]);
      blockerHeld = true;
      await pool.query(
        "create or replace function " + functionName + "() returns trigger language plpgsql as $fn$ begin perform pg_advisory_xact_lock(880001,123); return new; end $fn$"
      );
      await pool.query("create trigger " + triggerName + " before insert on " + triggerTable + " for each row execute function " + functionName + "()");
      const childPromise = childKind === "hearing"
        ? request("/api/hearings", {
            token: raceActors["hearing-create"].token, csrf: raceActors["hearing-create"].csrf, method: "POST",
            body: { case_id: caseId, hearing_at: hearingAt.toISOString(), hearing_type: "trial", notes: "child-first-parent-race-" + childKind }
          })
        : request("/api/actions", {
            token: raceActors["action-create"].token, csrf: raceActors["action-create"].csrf, method: "POST",
            body: { case_id: caseId, title: "child-first-parent-race-" + childKind }
          });
      await waitForLockWait("%insert into " + triggerTable + "%", 1, childKind + " INSERT paused after acquiring parent locks");
      const deletePromise = request("/api/clients/" + clientId, {
        token: raceActors["client-delete"].token, csrf: raceActors["client-delete"].csrf, method: "DELETE"
      });
      await waitForLockWait("%update clients%deleted_at = now()%", 1, "client DELETE queued behind child-first " + childKind + " create");
      const unlocked = await blocker.query("select pg_advisory_unlock($1,$2) as unlocked", [880001, 123]);
      assert.equal(unlocked.rows[0].unlocked, true, "must release the deterministic INSERT barrier");
      blockerHeld = false;
      const [childResponse, deleteResponse] = await Promise.all([childPromise, deletePromise]);
      assert.equal(childResponse.status, 201, childKind + " create that acquired parent locks first should commit");
      assert.equal(deleteResponse.status, 204, "queued client soft-delete should commit after child create");
      assert.ok((await pool.query("select deleted_at from clients where id=$1", [clientId])).rows[0].deleted_at,
        "client soft-delete must persist after the child-first transaction");
      assert.equal(await auditCount("client", "delete"), auditBefore.clientDelete + 1,
        "successful queued parent delete must emit exactly one audit row");
      assert.equal(await auditCount(childKind === "hearing" ? "hearing" : "case_action", "create"), auditBefore.childCreate + 1,
        "successful child create must emit exactly one audit row");
      if (childKind === "hearing") {
        const savedHearing = await pool.query("select id,hearing_at from hearings where office_id=$1 and case_id=$2 and notes=$3", [ids.officeA, caseId, "child-first-parent-race-hearing"]);
        assert.equal(savedHearing.rows.length, 1, "hearing row must persist exactly once");
        assert.equal(savedHearing.rows[0].hearing_at.getTime(), hearingAt.getTime(), "persisted hearing time must match request");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [caseId])).rows[0].next_hearing_at.getTime(), hearingAt.getTime(),
          "next_hearing_at must be refreshed atomically with the child-first hearing insert");
      } else {
        assert.equal((await pool.query("select count(*)::int as count from case_actions where office_id=$1 and case_id=$2 and title=$3", [ids.officeA, caseId, "child-first-parent-race-action"])).rows[0].count, 1,
          "action row must persist exactly once");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [caseId])).rows[0].next_hearing_at, null,
          "action creation must not mutate next_hearing_at");
      }
    } finally {
      if (blockerHeld) await blocker.query("select pg_advisory_unlock($1,$2)", [880001, 123]).catch(() => {});
      blocker.release();
      await pool.query("drop trigger if exists " + triggerName + " on " + triggerTable).catch(() => {});
      await pool.query("drop function if exists " + functionName + "()").catch(() => {});
    }
  }
  console.log("PASS: child-first hearing/action creates hold live-parent locks through commit; queued client soft-delete follows with exact audit counts and consistent next_hearing_at");

  // Explicitly inject audit INSERT failure for hearing/action creates. The business
  // row and its summary must roll back with the audit row, rather than leaving a
  // partially committed child or next_hearing_at change.
  const auditRollbackClient = crypto.randomUUID();
  const auditRollbackHearingCase = crypto.randomUUID();
  const auditRollbackActionCase = crypto.randomUUID();
  const auditRollbackPrefix = "CHILD-AUDIT-ROLLBACK-" + crypto.randomBytes(5).toString("hex");
  const auditRollbackHearingAt = new Date(Date.now() + 7 * 86400000);
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Audit rollback client',$3,$4,$4)",
    [auditRollbackClient, ids.officeA, "8" + String(Math.floor(Math.random() * 1000000000)).padStart(9, "0"), ids.userA]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Audit rollback hearing case',null,$5,$5),($6,$2,$3,$7,'Audit rollback action case',null,$5,$5)",
    [auditRollbackHearingCase, ids.officeA, auditRollbackClient, auditRollbackPrefix + "-H", ids.userA,
     auditRollbackActionCase, auditRollbackPrefix + "-A"]
  );
  const hearingAuditBeforeRollback = await auditCount("hearing", "create");
  const actionAuditBeforeRollback = await auditCount("case_action", "create");
  await pool.query(`
    create or replace function reject_hearing_action_create_audit() returns trigger language plpgsql as $fn$
    begin
      if new.entity_type in ('hearing','case_action') and new.action='create' then
        raise exception 'forced hearing/action audit failure for atomic rollback';
      end if;
      return new;
    end;
    $fn$;
    create trigger reject_hearing_action_create_audit_trigger before insert on audit_logs
      for each row execute function reject_hearing_action_create_audit();
  `);
  try {
    const failedHearingCreate = await request("/api/hearings", {
      token: raceActors["hearing-create"].token, csrf: raceActors["hearing-create"].csrf, method: "POST",
      body: { case_id: auditRollbackHearingCase, hearing_at: auditRollbackHearingAt.toISOString(), hearing_type: "trial", notes: "must-rollback-with-audit" }
    });
    const failedActionCreate = await request("/api/actions", {
      token: raceActors["action-create"].token, csrf: raceActors["action-create"].csrf, method: "POST",
      body: { case_id: auditRollbackActionCase, title: "must-rollback-with-audit" }
    });
    assert.equal(failedHearingCreate.status, 500, "hearing create must fail when its audit INSERT fails");
    assert.equal(failedActionCreate.status, 500, "action create must fail when its audit INSERT fails");
    assert.equal((await pool.query("select count(*)::int as count from hearings where office_id=$1 and case_id=$2 and notes='must-rollback-with-audit'", [ids.officeA, auditRollbackHearingCase])).rows[0].count, 0,
      "failed hearing create must leave no business row");
    assert.equal((await pool.query("select count(*)::int as count from case_actions where office_id=$1 and case_id=$2 and title='must-rollback-with-audit'", [ids.officeA, auditRollbackActionCase])).rows[0].count, 0,
      "failed action create must leave no business row");
    assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [auditRollbackHearingCase])).rows[0].next_hearing_at, null,
      "failed hearing create must roll back next_hearing_at");
    assert.equal(await auditCount("hearing", "create"), hearingAuditBeforeRollback, "failed hearing create must leave no audit row");
    assert.equal(await auditCount("case_action", "create"), actionAuditBeforeRollback, "failed action create must leave no audit row");
  } finally {
    await pool.query("drop trigger if exists reject_hearing_action_create_audit_trigger on audit_logs").catch(() => {});
    await pool.query("drop function if exists reject_hearing_action_create_audit()").catch(() => {});
  }
  console.log("PASS: hearing/action audit INSERT failures roll back child rows and next_hearing_at atomically");

  // Client soft-delete vs PATCH on hearings/actions while their source cases
  // remain live. Exercise both lock queue orders: delete first must reject child
  // writes; child writes first may commit, after which the queued delete commits.
  const clientPatchDeleteFirst = crypto.randomUUID();
  const clientPatchDeleteFirstHCase = crypto.randomUUID();
  const clientPatchDeleteFirstACase = crypto.randomUUID();
  const clientPatchDeleteFirstHearing = crypto.randomUUID();
  const clientPatchDeleteFirstAction = crypto.randomUUID();
  const clientPatchDeleteFirstPrefix = "CLIENT-PATCH-DELETE-FIRST-" + crypto.randomBytes(5).toString("hex");
  const clientPatchDeleteFirstHearingAt = new Date(Date.now() + 9 * 86400000);
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Delete-first PATCH race','8'||lpad(floor(random()*1000000000)::text,9,'0'),$3,$3)",
    [clientPatchDeleteFirst, ids.officeA, ids.userA]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Delete-first hearing case',$5,$6,$6),($7,$2,$3,$8,'Delete-first action case',null,$6,$6)",
    [clientPatchDeleteFirstHCase, ids.officeA, clientPatchDeleteFirst, clientPatchDeleteFirstPrefix + "-H", clientPatchDeleteFirstHearingAt, ids.userA,
     clientPatchDeleteFirstACase, clientPatchDeleteFirstPrefix + "-A"]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,$4,'hearing','scheduled',$5,$5)",
    [clientPatchDeleteFirstHearing, ids.officeA, clientPatchDeleteFirstHCase, clientPatchDeleteFirstHearingAt, ids.userA]
  );
  await pool.query(
    "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values($1,$2,$3,'Delete-first action title','todo','normal',$4,$4)",
    [clientPatchDeleteFirstAction, ids.officeA, clientPatchDeleteFirstACase, ids.userA]
  );
  const deleteFirstAuditBefore = {
    clientDelete: await auditCount("client", "delete"),
    hearingUpdate: await auditCount("hearing", "update"),
    actionUpdate: await auditCount("case_action", "update")
  };
  const deleteFirstBlocker = await pool.connect();
  let deleteFirstBlockerOpen = false;
  let deleteFirstDeletePromise;
  let deleteFirstPatchPromises = [];
  try {
    await deleteFirstBlocker.query("begin");
    await deleteFirstBlocker.query("select id from clients where id=$1 for update", [clientPatchDeleteFirst]);
    deleteFirstBlockerOpen = true;
    deleteFirstDeletePromise = request("/api/clients/" + clientPatchDeleteFirst, {
      token: raceActors["client-delete"].token, csrf: raceActors["client-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update clients%deleted_at = now()%", 1, "client delete before child PATCH");
    deleteFirstPatchPromises = [
      request("/api/hearings/" + clientPatchDeleteFirstHearing, {
        token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "PATCH",
        body: { hearing_at: new Date(clientPatchDeleteFirstHearingAt.getTime() + 86400000).toISOString() }
      }),
      request("/api/actions/" + clientPatchDeleteFirstAction, {
        token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf, method: "PATCH",
        body: { title: "Must not update after client delete" }
      })
    ];
    await waitForLockWait("%from public.lock_live_case_parents%", 2, "hearing/action PATCH waiting behind client delete");
  } finally {
    if (deleteFirstBlockerOpen) await deleteFirstBlocker.query("rollback").catch(() => {});
    deleteFirstBlocker.release();
  }
  const [deleteFirstDelete, deleteFirstHearingPatch, deleteFirstActionPatch] = await Promise.all([
    deleteFirstDeletePromise, ...deleteFirstPatchPromises
  ]);
  assert.equal(deleteFirstDelete.status, 204, "client delete queued first should commit");
  assert.equal(deleteFirstHearingPatch.status, 400, "hearing PATCH must reject when client delete wins");
  assert.deepEqual(deleteFirstHearingPatch.body, { error: "invalid_related_case" });
  assert.equal(deleteFirstActionPatch.status, 400, "action PATCH must reject when client delete wins");
  assert.deepEqual(deleteFirstActionPatch.body, { error: "invalid_related_case" });
  assert.ok((await pool.query("select deleted_at from clients where id=$1", [clientPatchDeleteFirst])).rows[0].deleted_at);
  assert.equal((await pool.query("select deleted_at from cases where id=$1", [clientPatchDeleteFirstHCase])).rows[0].deleted_at, null,
    "the source case itself remains live even though its client is deleted");
  assert.equal((await pool.query("select hearing_at from hearings where id=$1", [clientPatchDeleteFirstHearing])).rows[0].hearing_at.getTime(),
    clientPatchDeleteFirstHearingAt.getTime(), "rejected hearing PATCH must preserve hearing time");
  assert.equal((await pool.query("select title from case_actions where id=$1", [clientPatchDeleteFirstAction])).rows[0].title,
    "Delete-first action title", "rejected action PATCH must preserve its title");
  assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [clientPatchDeleteFirstHCase])).rows[0].next_hearing_at.getTime(),
    clientPatchDeleteFirstHearingAt.getTime(), "rejected hearing PATCH must not alter next_hearing_at");
  assert.equal(await auditCount("client", "delete"), deleteFirstAuditBefore.clientDelete + 1);
  assert.equal(await auditCount("hearing", "update"), deleteFirstAuditBefore.hearingUpdate,
    "rejected hearing PATCH must not emit audit");
  assert.equal(await auditCount("case_action", "update"), deleteFirstAuditBefore.actionUpdate,
    "rejected action PATCH must not emit audit");

  const clientPatchFirst = crypto.randomUUID();
  const clientPatchFirstHCase = crypto.randomUUID();
  const clientPatchFirstACase = crypto.randomUUID();
  const clientPatchFirstHearing = crypto.randomUUID();
  const clientPatchFirstAction = crypto.randomUUID();
  const clientPatchFirstPrefix = "CLIENT-PATCH-FIRST-" + crypto.randomBytes(5).toString("hex");
  const clientPatchFirstOldHearingAt = new Date(Date.now() + 10 * 86400000);
  const clientPatchFirstNewHearingAt = new Date(Date.now() + 14 * 86400000);
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','PATCH-first race','8'||lpad(floor(random()*1000000000)::text,9,'0'),$3,$3)",
    [clientPatchFirst, ids.officeA, ids.userA]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'PATCH-first hearing case',$5,$6,$6),($7,$2,$3,$8,'PATCH-first action case',null,$6,$6)",
    [clientPatchFirstHCase, ids.officeA, clientPatchFirst, clientPatchFirstPrefix + "-H", clientPatchFirstOldHearingAt, ids.userA,
     clientPatchFirstACase, clientPatchFirstPrefix + "-A"]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,$4,'hearing','scheduled',$5,$5)",
    [clientPatchFirstHearing, ids.officeA, clientPatchFirstHCase, clientPatchFirstOldHearingAt, ids.userA]
  );
  await pool.query(
    "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values($1,$2,$3,'PATCH-first action title','todo','normal',$4,$4)",
    [clientPatchFirstAction, ids.officeA, clientPatchFirstACase, ids.userA]
  );
  const patchFirstAuditBefore = {
    clientDelete: await auditCount("client", "delete"),
    hearingUpdate: await auditCount("hearing", "update"),
    actionUpdate: await auditCount("case_action", "update")
  };
  const patchFirstBlocker = await pool.connect();
  let patchFirstBlockerOpen = false;
  let patchFirstDeletePromise;
  let patchFirstChildPromises = [];
  try {
    await patchFirstBlocker.query("begin");
    await patchFirstBlocker.query("select id from clients where id=$1 for update", [clientPatchFirst]);
    patchFirstBlockerOpen = true;
    patchFirstChildPromises = [
      request("/api/hearings/" + clientPatchFirstHearing, {
        token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "PATCH",
        body: { hearing_at: clientPatchFirstNewHearingAt.toISOString() }
      }),
      request("/api/actions/" + clientPatchFirstAction, {
        token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf, method: "PATCH",
        body: { title: "Action updated before client delete" }
      })
    ];
    await waitForLockWait("%from public.lock_live_case_parents%", 2, "hearing/action PATCH queued before client delete");
    patchFirstDeletePromise = request("/api/clients/" + clientPatchFirst, {
      token: raceActors["client-delete"].token, csrf: raceActors["client-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update clients%deleted_at = now()%", 1, "client delete queued behind child PATCHes");
  } finally {
    if (patchFirstBlockerOpen) await patchFirstBlocker.query("rollback").catch(() => {});
    patchFirstBlocker.release();
  }
  const [patchFirstHearingPatch, patchFirstActionPatch, patchFirstDelete] = await Promise.all([
    ...patchFirstChildPromises, patchFirstDeletePromise
  ]);
  assert.equal(patchFirstHearingPatch.status, 200, "hearing PATCH queued before client delete should commit");
  assert.equal(patchFirstActionPatch.status, 200, "action PATCH queued before client delete should commit");
  assert.equal(patchFirstDelete.status, 204, "client delete queued behind successful child PATCHes should commit");
  assert.ok((await pool.query("select deleted_at from clients where id=$1", [clientPatchFirst])).rows[0].deleted_at);
  assert.equal((await pool.query("select title from case_actions where id=$1", [clientPatchFirstAction])).rows[0].title,
    "Action updated before client delete");
  assert.equal((await pool.query("select hearing_at from hearings where id=$1", [clientPatchFirstHearing])).rows[0].hearing_at.getTime(),
    clientPatchFirstNewHearingAt.getTime());
  assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [clientPatchFirstHCase])).rows[0].next_hearing_at.getTime(),
    clientPatchFirstNewHearingAt.getTime(), "hearing PATCH must atomically refresh next_hearing_at before the queued client delete");
  assert.equal(await auditCount("client", "delete"), patchFirstAuditBefore.clientDelete + 1);
  assert.equal(await auditCount("hearing", "update"), patchFirstAuditBefore.hearingUpdate + 1);
  assert.equal(await auditCount("case_action", "update"), patchFirstAuditBefore.actionUpdate + 1);
  console.log("PASS: client soft-delete races with hearing/action PATCH in both lock orders; live-parent checks, audit atomicity, and next_hearing_at remain consistent");

  // A deleted client must hide its still-retained cases and every child read path.
  assert.equal((await request("/api/clients/" + raceClient, { token: tokenA, csrf: csrfA })).status, 404);
  assert.equal((await request("/api/clients/lookup?national_id=9876501234", { token: tokenA, csrf: csrfA })).status, 404);
  const clientRestoreViaPatch = await request("/api/clients/" + raceClient, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { deleted_at: null }
  });
  assert.equal(clientRestoreViaPatch.status, 400, "client API must not permit restoring soft deletion through a writable field");
  assert.deepEqual(clientRestoreViaPatch.body, { error: "invalid_client_update" });
  assert.equal((await request("/api/clients/" + raceClient + "/restore", {
    token: tokenA, csrf: csrfA, method: "POST", body: {}
  })).status, 404, "no client restore endpoint is exposed");
  assert.equal((await request("/api/cases/" + hiddenCase, { token: tokenA, csrf: csrfA })).status, 404);
  assert.equal((await request("/api/cases?search=" + encodeURIComponent(raceClientCaseNumber + "-DEPENDENT"), { token: tokenA, csrf: csrfA })).body.data.some(row => row.id === hiddenCase), false);
  assert.equal((await request("/api/hearings/" + hiddenHearing, { token: tokenA, csrf: csrfA })).status, 404);
  assert.equal((await request("/api/hearings", { token: tokenA, csrf: csrfA })).body.data.some(row => row.id === hiddenHearing), false);
  assert.equal((await request("/api/actions/" + hiddenAction, { token: tokenA, csrf: csrfA })).status, 404);
  assert.equal((await request("/api/actions", { token: tokenA, csrf: csrfA })).body.data.some(row => row.id === hiddenAction), false);
  assert.equal((await request("/api/case-documents/" + hiddenDocument, { token: tokenA, csrf: csrfA })).status, 404);
  assert.equal((await request("/api/case-documents", { token: tokenA, csrf: csrfA })).body.data.some(row => row.id === hiddenDocument), false);

  const hiddenWriteAuditBefore = await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_id = any($2::uuid[])",
    [ids.officeA, [hiddenCase, hiddenHearing, hiddenAction, hiddenDocument]]
  );
  const hiddenHearingPatch = await request("/api/hearings/" + hiddenHearing, {
    token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "PATCH",
    body: { hearing_type: "cannot update hidden parent" }
  });
  const hiddenActionPatch = await request("/api/actions/" + hiddenAction, {
    token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf, method: "PATCH",
    body: { title: "Cannot update hidden parent" }
  });
  const hiddenDocumentPatch = await request("/api/case-documents/" + hiddenDocument, {
    token: raceActors["document-patch"].token, csrf: raceActors["document-patch"].csrf, method: "PATCH",
    idempotencyKey: "hidden-client-document-patch-01",
    body: { title: "Cannot update hidden parent" }
  });
  assert.equal(hiddenHearingPatch.status, 400, "hearing mutation must reject a case whose client is deleted");
  assert.deepEqual(hiddenHearingPatch.body, { error: "invalid_related_case" });
  assert.equal(hiddenActionPatch.status, 400, "action mutation must reject a case whose client is deleted");
  assert.deepEqual(hiddenActionPatch.body, { error: "invalid_related_case" });
  assert.equal(hiddenDocumentPatch.status, 404, "document mutation must hide a document whose client is deleted");
  assert.deepEqual(hiddenDocumentPatch.body, { error: "document_not_found" });
  assert.equal((await pool.query("select hearing_type from hearings where id=$1", [hiddenHearing])).rows[0].hearing_type, "hearing");
  assert.equal((await pool.query("select title from case_actions where id=$1", [hiddenAction])).rows[0].title, "Action hidden by deleted client");
  assert.equal((await pool.query("select title from case_documents where id=$1", [hiddenDocument])).rows[0].title, "Document hidden by deleted client");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, raceActors["document-patch"].userId, "hidden-client-document-patch-01"])).rows[0].count, 0,
    "rejected document mutation must roll back its idempotency reservation");
  assert.equal(Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_id = any($2::uuid[])",
    [ids.officeA, [hiddenCase, hiddenHearing, hiddenAction, hiddenDocument]]
  )).rows[0].count), Number(hiddenWriteAuditBefore.rows[0].count),
    "rejected mutations on hidden child records must not add audit rows");

  const hiddenHearingCount = Number((await pool.query("select count(*)::int as count from hearings where office_id=$1", [ids.officeA])).rows[0].count);
  const hiddenActionCount = Number((await pool.query("select count(*)::int as count from case_actions where office_id=$1", [ids.officeA])).rows[0].count);
  const hiddenDocumentCount = Number((await pool.query("select count(*)::int as count from case_documents where office_id=$1", [ids.officeA])).rows[0].count);
  const createHearingUnderHiddenClient = await request("/api/hearings", {
    token: raceActors["hearing-create"].token, csrf: raceActors["hearing-create"].csrf, method: "POST",
    body: { case_id: hiddenCase, hearing_at: new Date(Date.now()+86400000).toISOString(), hearing_type: "trial" }
  });
  const createActionUnderHiddenClient = await request("/api/actions", {
    token: raceActors["action-create"].token, csrf: raceActors["action-create"].csrf, method: "POST",
    body: { case_id: hiddenCase, title: "Cannot create under hidden client" }
  });
  const createDocumentUnderHiddenClient = await request("/api/case-documents", {
    token: raceActors["document-create"].token, csrf: raceActors["document-create"].csrf, method: "POST",
    idempotencyKey: "hidden-client-document-create-01",
    body: { case_id: hiddenCase, title: "Cannot create under hidden client", document_type: "evidence", confidentiality: "normal" },
    portToUse: retryPort
  });
  for (const [label, response] of [
    ["hearing create", createHearingUnderHiddenClient],
    ["action create", createActionUnderHiddenClient],
    ["document create", createDocumentUnderHiddenClient]
  ]) {
    assert.equal(response.status, 400, label + " must reject a case whose client is soft-deleted");
    assert.deepEqual(response.body, { error: "invalid_related_case" });
  }
  assert.equal((await pool.query("select count(*)::int as count from hearings where office_id=$1", [ids.officeA])).rows[0].count, hiddenHearingCount);
  assert.equal((await pool.query("select count(*)::int as count from case_actions where office_id=$1", [ids.officeA])).rows[0].count, hiddenActionCount);
  assert.equal((await pool.query("select count(*)::int as count from case_documents where office_id=$1", [ids.officeA])).rows[0].count, hiddenDocumentCount);
  assert.equal(Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_id = any($2::uuid[])",
    [ids.officeA, [hiddenCase, hiddenHearing, hiddenAction, hiddenDocument]]
  )).rows[0].count), Number(hiddenWriteAuditBefore.rows[0].count),
    "rejected child creates under a deleted client must not emit audit rows");

  const hiddenChildDeleteAuditBefore = Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_id = any($2::uuid[])",
    [ids.officeA, [hiddenHearing, hiddenAction, hiddenDocument]]
  )).rows[0].count);
  const hiddenHearingDelete = await request("/api/hearings/" + hiddenHearing, {
    token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "DELETE"
  });
  const hiddenActionDelete = await request("/api/actions/" + hiddenAction, {
    token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf, method: "DELETE"
  });
  const hiddenDocumentDelete = await request("/api/case-documents/" + hiddenDocument, {
    token: tokenA, csrf: csrfA, method: "DELETE", idempotencyKey: "hidden-client-document-delete-01"
  });
  assert.equal(hiddenHearingDelete.status, 404, "hearing delete must not mutate a child whose client parent is soft-deleted");
  assert.equal(hiddenActionDelete.status, 404, "action delete must not mutate a child whose client parent is soft-deleted");
  assert.equal(hiddenDocumentDelete.status, 404, "document delete must not mutate a child whose client parent is soft-deleted");
  assert.equal((await pool.query("select deleted_at from hearings where id=$1", [hiddenHearing])).rows[0].deleted_at, null);
  assert.equal((await pool.query("select deleted_at from case_actions where id=$1", [hiddenAction])).rows[0].deleted_at, null);
  assert.equal((await pool.query("select deleted_at from case_documents where id=$1", [hiddenDocument])).rows[0].deleted_at, null);
  assert.equal(Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_id = any($2::uuid[])",
    [ids.officeA, [hiddenHearing, hiddenAction, hiddenDocument]]
  )).rows[0].count), hiddenChildDeleteAuditBefore, "rejected hidden-child deletes must not emit audit events");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, "hidden-client-document-delete-01"])).rows[0].count, 0,
    "rejected document delete must roll back its idempotency reservation");

  // Physical parent deletion must be restricted while retained child rows exist.
  await assert.rejects(pool.query("delete from clients where id=$1 and office_id=$2", [raceClient, ids.officeA]),
    error => error.code === "23503", "physical client deletion must be blocked by the retained case FK");
  await assert.rejects(pool.query("delete from cases where id=$1 and office_id=$2", [hiddenCase, ids.officeA]),
    error => error.code === "23503", "physical case deletion must be blocked by retained hearing/action/document FKs");
  assert.ok((await pool.query("select deleted_at from clients where id=$1", [raceClient])).rows[0].deleted_at,
    "failed physical delete must preserve soft-delete tombstone");
  assert.equal((await pool.query("select count(*)::int as count from audit_logs where office_id=$1 and entity_type='client' and entity_id=$2 and action='delete'",
    [ids.officeA, raceClient])).rows[0].count, 1, "physical delete attempt must not alter the soft-delete audit history");
  console.log("PASS: soft-deleted client hides dependent case/hearing/action/document reads, blocks child mutations, and physical parent deletes are FK-restricted");

  // Case soft-delete vs hearing/action/document create and reassignment/update.
  const raceCaseClient = crypto.randomUUID();
  const raceSourceCase = crypto.randomUUID();
  const raceTargetCase = crypto.randomUUID();
  const raceSourceHearing = crypto.randomUUID();
  const raceSourceAction = crypto.randomUUID();
  const raceDeletedCaseHearing = crypto.randomUUID();
  const raceDeletedCaseAction = crypto.randomUUID();
  const raceParentDoc = crypto.randomUUID();
  const caseNumberPrefix = "SOFT-DELETE-CASE-" + crypto.randomBytes(5).toString("hex");
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Case parent race client','8765401234',$3,$3)",
    [raceCaseClient, ids.officeA, ids.userA]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Source live case',$6,$6),($5,$2,$3,$7,'Target case to delete',$6,$6)",
    [raceSourceCase, ids.officeA, raceCaseClient, caseNumberPrefix + "-SOURCE", raceTargetCase, ids.userA, caseNumberPrefix + "-TARGET"]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,now()+interval '9 days','hearing','scheduled',$4,$4)",
    [raceSourceHearing, ids.officeA, raceSourceCase, ids.userA]
  );
  await pool.query(
    "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values($1,$2,$3,'Source action','todo','normal',$4,$4)",
    [raceSourceAction, ids.officeA, raceSourceCase, ids.userA]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,now()+interval '10 days','hearing','scheduled',$4,$4)",
    [raceDeletedCaseHearing, ids.officeA, raceTargetCase, ids.userA]
  );
  await pool.query(
    "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values($1,$2,$3,'Action under target case','todo','normal',$4,$4)",
    [raceDeletedCaseAction, ids.officeA, raceTargetCase, ids.userA]
  );
  await pool.query(
    "insert into case_documents(id,office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,$3,'Document before parent deletion','evidence','normal',$4,$4)",
    [raceParentDoc, ids.officeA, raceTargetCase, ids.userA]
  );
  const caseDeleteAuditBefore = await auditCount("case", "delete");
  const hearingCreateAuditBefore = await auditCount("hearing", "create");
  const hearingUpdateAuditBefore = await auditCount("hearing", "update");
  const actionCreateAuditBefore = await auditCount("case_action", "create");
  const actionUpdateAuditBefore = await auditCount("case_action", "update");
  const documentCreateAuditBefore = await auditCount("case_document", "create");
  const documentUpdateAuditBefore = await auditCount("case_document", "update");
  const documentCountBefore = Number((await pool.query("select count(*)::int as count from case_documents where office_id=$1", [ids.officeA])).rows[0].count);
  const hearingCountBefore = Number((await pool.query("select count(*)::int as count from hearings where office_id=$1", [ids.officeA])).rows[0].count);
  const actionCountBefore = Number((await pool.query("select count(*)::int as count from case_actions where office_id=$1", [ids.officeA])).rows[0].count);
  const caseBlocker = await pool.connect();
  let caseBlockerOpen = false;
  let caseDeletePromise;
  let childPromises = [];
  try {
    await caseBlocker.query("begin");
    await caseBlocker.query("select id from cases where id=$1 for update", [raceTargetCase]);
    caseBlockerOpen = true;
    caseDeletePromise = request("/api/cases/" + raceTargetCase, {
      token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update cases%deleted_at = now()%", 1, "case delete");
    const childSettled = new Set();
    const trackChild = (label, promise) => promise.then(response => {
      childSettled.add(label);
      return response;
    });
    childPromises = [
      trackChild("hearing create", request("/api/hearings", {
        token: raceActors["hearing-create"].token, csrf: raceActors["hearing-create"].csrf, method: "POST",
        body: { case_id: raceTargetCase, hearing_at: new Date(Date.now()+86400000).toISOString(), hearing_type: "trial" }
      })),
      trackChild("action create", request("/api/actions", {
        token: raceActors["action-create"].token, csrf: raceActors["action-create"].csrf, method: "POST",
        body: { case_id: raceTargetCase, title: "Must not attach to deleted case" }
      })),
      trackChild("hearing reassignment", request("/api/hearings/" + raceSourceHearing, {
        token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "PATCH",
        body: { case_id: raceTargetCase }
      })),
      trackChild("action reassignment", request("/api/actions/" + raceSourceAction, {
        token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf, method: "PATCH",
        body: { case_id: raceTargetCase }
      })),
      trackChild("document create", request("/api/case-documents", {
        token: raceActors["document-create"].token, csrf: raceActors["document-create"].csrf, method: "POST",
        body: { case_id: raceTargetCase, title: "Must not attach to deleted case", document_type: "evidence", confidentiality: "normal" },
        portToUse: retryPort
      })),
      trackChild("document update", request("/api/case-documents/" + raceParentDoc, {
        token: raceActors["document-patch"].token, csrf: raceActors["document-patch"].csrf, method: "PATCH",
        idempotencyKey: "parent-case-delete-race-01",
        body: { title: "Must not update after parent deletion" }
      }))
    ];
    // Five operations wait directly in the parent-row SELECT. The remaining
    // metadata PATCH may be waiting earlier in its idempotency/document lock path;
    // it must not return a response before the parent delete is allowed to commit.
    await waitForLockWait("%from public.lock_live_case_parents%", 5, "hearing/action/document create and reassignment");
    assert.equal(childSettled.size, 0,
      "no child mutation may finish while the parent soft-delete is still blocked; early responses: " + [...childSettled].join(", "));
  } finally {
    if (caseBlockerOpen) await caseBlocker.query("rollback").catch(() => {});
    caseBlocker.release();
  }
  const [caseDeleteRace, hearingCreateRace, actionCreateRace, hearingPatchRace, actionPatchRace, documentCreateRace, documentPatchRace] =
    await Promise.all([caseDeletePromise, ...childPromises]);
  assert.equal(caseDeleteRace.status, 204, "case soft-delete should win the queued parent-row race");
  for (const [label, response, expectedError] of [
    ["hearing create", hearingCreateRace, "invalid_related_case"],
    ["action create", actionCreateRace, "invalid_related_case"],
    ["hearing reassignment", hearingPatchRace, "invalid_related_case"],
    ["action reassignment", actionPatchRace, "invalid_related_case"],
    ["document create", documentCreateRace, "invalid_related_case"]
  ]) {
    assert.equal(response.status, 400, label + " must reject a soft-deleted parent case");
    assert.deepEqual(response.body, { error: expectedError }, label + " response must remain sanitized");
  }
  assert.equal(documentPatchRace.status, 404, "document PATCH must reject a soft-deleted parent case");
  assert.deepEqual(documentPatchRace.body, { error: "document_not_found" });
  assert.ok((await pool.query("select deleted_at from cases where id=$1", [raceTargetCase])).rows[0].deleted_at);
  const caseRestoreViaPatch = await request("/api/cases/" + raceTargetCase, {
    token: tokenA, csrf: csrfA, method: "PATCH", body: { deleted_at: null }
  });
  assert.equal(caseRestoreViaPatch.status, 400, "case PATCH schema must not permit direct deleted_at restoration");
  assert.deepEqual(caseRestoreViaPatch.body, { error: "invalid_case_update" });
  assert.equal((await request("/api/cases/" + raceTargetCase + "/restore", {
    token: tokenA, csrf: csrfA, method: "POST", body: {}
  })).status, 404, "no case restore endpoint is exposed");
  assert.equal((await pool.query("select deleted_at from cases where id=$1", [raceTargetCase])).rows[0].deleted_at !== null, true);
  assert.equal((await pool.query("select count(*)::int as count from hearings where office_id=$1", [ids.officeA])).rows[0].count, hearingCountBefore,
    "hearing create must not persist against a soft-deleted case");
  assert.equal((await pool.query("select count(*)::int as count from case_actions where office_id=$1", [ids.officeA])).rows[0].count, actionCountBefore,
    "action create must not persist against a soft-deleted case");
  assert.equal((await pool.query("select case_id from hearings where id=$1", [raceSourceHearing])).rows[0].case_id, raceSourceCase,
    "failed hearing reassignment must preserve its original parent");
  assert.equal((await pool.query("select case_id from case_actions where id=$1", [raceSourceAction])).rows[0].case_id, raceSourceCase,
    "failed action reassignment must preserve its original parent");
  const docAfterParentRace = await pool.query("select title from case_documents where id=$1", [raceParentDoc]);
  assert.equal(docAfterParentRace.rows[0].title, "Document before parent deletion",
    "document metadata must not change after its parent case is soft-deleted");
  assert.equal((await pool.query("select count(*)::int as count from case_documents where office_id=$1", [ids.officeA])).rows[0].count, documentCountBefore,
    "document create must not persist against a soft-deleted case");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, raceActors["document-patch"].userId, "parent-case-delete-race-01"])).rows[0].count, 0,
    "rejected document update must roll back its idempotency reservation");
  assert.equal(await auditCount("case", "delete"), caseDeleteAuditBefore + 1,
    "case soft-delete must commit exactly one audit row");
  assert.equal(await auditCount("hearing", "create"), hearingCreateAuditBefore, "rejected hearing create must not emit audit");
  assert.equal(await auditCount("hearing", "update"), hearingUpdateAuditBefore, "rejected hearing reassignment must not emit audit");
  assert.equal(await auditCount("case_action", "create"), actionCreateAuditBefore, "rejected action create must not emit audit");
  assert.equal(await auditCount("case_action", "update"), actionUpdateAuditBefore, "rejected action reassignment must not emit audit");
  assert.equal(await auditCount("case_document", "create"), documentCreateAuditBefore, "rejected document create must not emit audit");
  assert.equal(await auditCount("case_document", "update"), documentUpdateAuditBefore, "rejected document update must not emit audit");

  // Regression: a PATCH must not "rescue" a child by reassigning it away
  // after its source parent has already been soft-deleted. The previous tests
  // cover a deleted destination; this covers a deleted source and preserves
  // the source/destination lock-order invariant.
  const sourceMoveTargetCase = crypto.randomUUID();
  const sourceMoveHearing = crypto.randomUUID();
  const sourceMoveAction = crypto.randomUUID();
  const sourceMoveDocument = crypto.randomUUID();
  const sourceMoveCaseNumber = caseNumberPrefix + "-MOVE-TARGET";
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Live reassignment destination',$5,$5)",
    [sourceMoveTargetCase, ids.officeA, raceCaseClient, sourceMoveCaseNumber, ids.userA]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,now()+interval '12 days','hearing','scheduled',$4,$4)",
    [sourceMoveHearing, ids.officeA, raceSourceCase, ids.userA]
  );
  await pool.query(
    "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values($1,$2,$3,'Source-parent move action','todo','normal',$4,$4)",
    [sourceMoveAction, ids.officeA, raceSourceCase, ids.userA]
  );
  await pool.query(
    "insert into case_documents(id,office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,$3,'Source-parent move document','evidence','normal',$4,$4)",
    [sourceMoveDocument, ids.officeA, raceSourceCase, ids.userA]
  );
  const sourceMoveAuditBefore = {
    caseDelete: await auditCount("case", "delete"),
    hearingUpdate: await auditCount("hearing", "update"),
    actionUpdate: await auditCount("case_action", "update"),
    documentUpdate: await auditCount("case_document", "update")
  };
  const sourceBlocker = await pool.connect();
  let sourceBlockerOpen = false;
  let sourceDeletePromise;
  let sourcePatchPromises = [];
  try {
    await sourceBlocker.query("begin");
    await sourceBlocker.query("select id from cases where id=$1 for update", [raceSourceCase]);
    sourceBlockerOpen = true;
    sourceDeletePromise = request("/api/cases/" + raceSourceCase, {
      token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update cases%deleted_at = now()%", 1, "source case delete");
    sourcePatchPromises = [
      request("/api/hearings/" + sourceMoveHearing, {
        token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
        method: "PATCH", body: { case_id: sourceMoveTargetCase }
      }),
      request("/api/actions/" + sourceMoveAction, {
        token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf,
        method: "PATCH", body: { case_id: sourceMoveTargetCase }
      }),
      request("/api/case-documents/" + sourceMoveDocument, {
        token: raceActors["document-patch"].token, csrf: raceActors["document-patch"].csrf,
        method: "PATCH", idempotencyKey: "source-case-delete-patch-01",
        body: { title: "Must not mutate child under deleted source" }
      })
    ];
    await waitForLockWait("%from public.lock_live_case_parents%", 3, "child PATCHes waiting on source case deletion");
  } finally {
    if (sourceBlockerOpen) await sourceBlocker.query("rollback").catch(() => {});
    sourceBlocker.release();
  }
  const [sourceDeleteResult, sourceHearingPatchResult, sourceActionPatchResult, sourceDocumentPatchResult] =
    await Promise.all([sourceDeletePromise, ...sourcePatchPromises]);
  assert.equal(sourceDeleteResult.status, 204, "source case soft-delete should commit before queued child PATCHes");
  assert.equal(sourceHearingPatchResult.status, 400, "hearing PATCH must reject a deleted source parent even when destination is live");
  assert.deepEqual(sourceHearingPatchResult.body, { error: "invalid_related_case" });
  assert.equal(sourceActionPatchResult.status, 400, "action PATCH must reject a deleted source parent even when destination is live");
  assert.deepEqual(sourceActionPatchResult.body, { error: "invalid_related_case" });
  assert.equal(sourceDocumentPatchResult.status, 404, "document metadata PATCH must reject a deleted source parent");
  assert.deepEqual(sourceDocumentPatchResult.body, { error: "document_not_found" });
  assert.equal((await pool.query("select case_id from hearings where id=$1", [sourceMoveHearing])).rows[0].case_id, raceSourceCase);
  assert.equal((await pool.query("select case_id from case_actions where id=$1", [sourceMoveAction])).rows[0].case_id, raceSourceCase);
  assert.equal((await pool.query("select title from case_documents where id=$1", [sourceMoveDocument])).rows[0].title, "Source-parent move document");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, raceActors["document-patch"].userId, "source-case-delete-patch-01"])).rows[0].count, 0,
    "rejected document PATCH against a deleted source must roll back its idempotency reservation");
  assert.equal(await auditCount("case", "delete"), sourceMoveAuditBefore.caseDelete + 1);
  assert.equal(await auditCount("hearing", "update"), sourceMoveAuditBefore.hearingUpdate,
    "rejected source-parent hearing reassignment must not write audit");
  assert.equal(await auditCount("case_action", "update"), sourceMoveAuditBefore.actionUpdate,
    "rejected source-parent action reassignment must not write audit");
  assert.equal(await auditCount("case_document", "update"), sourceMoveAuditBefore.documentUpdate,
    "rejected source-parent document PATCH must not write audit");
  assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [sourceMoveTargetCase])).rows[0].next_hearing_at, null,
    "rejected hearing reassignment must not change the destination next_hearing_at summary");
  console.log("PASS: source-parent soft-delete wins against hearing/action reassignment and document PATCH; no child, audit, idempotency, or destination summary mutation survives");

  const deletedCaseChildAuditBefore = Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_id = any($2::uuid[])",
    [ids.officeA, [raceDeletedCaseHearing, raceDeletedCaseAction, raceParentDoc]]
  )).rows[0].count);
  const deletedCaseHearingDelete = await request("/api/hearings/" + raceDeletedCaseHearing, {
    token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "DELETE"
  });
  const deletedCaseActionDelete = await request("/api/actions/" + raceDeletedCaseAction, {
    token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf, method: "DELETE"
  });
  const deletedCaseDocumentDelete = await request("/api/case-documents/" + raceParentDoc, {
    token: tokenA, csrf: csrfA, method: "DELETE", idempotencyKey: "deleted-case-document-delete-01"
  });
  assert.equal(deletedCaseHearingDelete.status, 404, "hearing delete must reject a soft-deleted case parent");
  assert.equal(deletedCaseActionDelete.status, 404, "action delete must reject a soft-deleted case parent");
  assert.equal(deletedCaseDocumentDelete.status, 404, "document delete must reject a soft-deleted case parent");
  assert.equal((await pool.query("select deleted_at from hearings where id=$1", [raceDeletedCaseHearing])).rows[0].deleted_at, null);
  assert.equal((await pool.query("select deleted_at from case_actions where id=$1", [raceDeletedCaseAction])).rows[0].deleted_at, null);
  assert.equal((await pool.query("select deleted_at from case_documents where id=$1", [raceParentDoc])).rows[0].deleted_at, null);
  assert.equal(Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_id = any($2::uuid[])",
    [ids.officeA, [raceDeletedCaseHearing, raceDeletedCaseAction, raceParentDoc]]
  )).rows[0].count), deletedCaseChildAuditBefore, "rejected deletes under a soft-deleted case must not emit audit events");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.officeA, ids.userA, "deleted-case-document-delete-01"])).rows[0].count, 0,
    "rejected document delete under a deleted case must roll back its idempotency reservation");
  console.log("PASS: soft-deleted case/client descendants cannot be deleted through child APIs; rejected child deletes leave state, idempotency, and audit unchanged");

  // Exercise both serial orders for child DELETE versus parent soft-delete.
  // In child-first cases, the child transaction already holds the live-parent
  // locks when the parent DELETE starts; in parent-first cases, parent DELETE
  // is queued on a held row lock before the child request attempts its lock.
  const deleteRacePrefix = "CHILD-DELETE-RACE-" + crypto.randomBytes(4).toString("hex");
  const deleteRaceTargets = {
    hearing: { table: "hearings", path: "/api/hearings/", entity: "hearing", token: raceActors["hearing-patch"], insert: async (id, caseId) => pool.query(
      "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,now()+interval '14 days','hearing','scheduled',$4,$4)",
      [id, ids.officeA, caseId, ids.userA]) },
    action: { table: "case_actions", path: "/api/actions/", entity: "case_action", token: raceActors["action-patch"], insert: async (id, caseId) => pool.query(
      "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values($1,$2,$3,'Concurrent delete action','todo','normal',$4,$4)",
      [id, ids.officeA, caseId, ids.userA]) },
    document: { table: "case_documents", path: "/api/case-documents/", entity: "case_document", token: raceActors["document-patch"], insert: async (id, caseId) => pool.query(
      "insert into case_documents(id,office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,$3,'Concurrent delete document','evidence','normal',$4,$4)",
      [id, ids.officeA, caseId, ids.userA]) }
  };
  await pool.query(`
    create or replace function pause_child_soft_delete_race() returns trigger language plpgsql as $fn$
    begin
      if old.deleted_at is null and new.deleted_at is not null then
        perform pg_sleep(0.6);
      end if;
      return new;
    end
    $fn$;
    create trigger pause_hearing_soft_delete_race before update on hearings
      for each row execute function pause_child_soft_delete_race();
    create trigger pause_action_soft_delete_race before update on case_actions
      for each row execute function pause_child_soft_delete_race();
    create trigger pause_document_soft_delete_race before update on case_documents
      for each row execute function pause_child_soft_delete_race();
  `);

  try {
    for (const parentKind of ["case", "client"]) {
      for (const childKind of ["hearing", "action", "document"]) {
        const spec = deleteRaceTargets[childKind];
        for (const order of ["child-first", "parent-first"]) {
          const clientId = crypto.randomUUID();
          const caseId = crypto.randomUUID();
          const childId = crypto.randomUUID();
          const caseNumber = deleteRacePrefix + "-" + parentKind + "-" + childKind + "-" + order;
          await pool.query(
            "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Delete race client','7654301234',$3,$3)",
            [clientId, ids.officeA, ids.userA]
          );
          await pool.query(
            "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Delete race case',$5,$5)",
            [caseId, ids.officeA, clientId, caseNumber, ids.userA]
          );
          await spec.insert(childId, caseId);

          const parentPath = parentKind === "case" ? "/api/cases/" + caseId : "/api/clients/" + clientId;
          const parentId = parentKind === "case" ? caseId : clientId;
          const parentTable = parentKind === "case" ? "cases" : "clients";
          const parentDeleteAuditBefore = Number((await pool.query(
            "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action='delete'",
            [ids.officeA, parentKind, parentId]
          )).rows[0].count);
          const childDeleteAuditBefore = Number((await pool.query(
            "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action='delete'",
            [ids.officeA, spec.entity, childId]
          )).rows[0].count);
          const idemKey = "parent-delete-race-" + parentKind + "-" + childKind + "-" + order;
          let blocker;
          let blockerOpen = false;
          let parentPromise;
          let childPromise;
          try {
            if (order === "child-first") {
              childPromise = request(spec.path + childId, {
                token: spec.token.token, csrf: spec.token.csrf, method: "DELETE",
                ...(childKind === "document" ? { idempotencyKey: idemKey } : {})
              });
              const deadline = Date.now() + 5000;
              let sleeping = false;
              while (Date.now() < deadline) {
                const active = await pool.query(
                  "select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event='PgSleep' and query ilike $1",
                  ["%update " + spec.table + " set deleted_at%"]
                );
                if (active.rows[0].count > 0) { sleeping = true; break; }
                await delay(20);
              }
              assert.ok(sleeping, order + " " + parentKind + "/" + childKind + " child DELETE must reach the pause after parent locks are held");
              parentPromise = request(parentPath, {
                token: raceActors[parentKind === "case" ? "case-delete" : "client-delete"].token,
                csrf: raceActors[parentKind === "case" ? "case-delete" : "client-delete"].csrf,
                method: "DELETE"
              });
              await waitForLockWait("%update " + parentTable + "%deleted_at = now()%", 1,
                order + " " + parentKind + "/" + childKind + " parent DELETE must wait behind child-held parent lock");
            } else {
              blocker = await pool.connect();
              await blocker.query("begin");
              await blocker.query("select id from " + parentTable + " where id=$1 for update", [parentId]);
              blockerOpen = true;
              parentPromise = request(parentPath, {
                token: raceActors[parentKind === "case" ? "case-delete" : "client-delete"].token,
                csrf: raceActors[parentKind === "case" ? "case-delete" : "client-delete"].csrf,
                method: "DELETE"
              });
              await waitForLockWait("%update " + parentTable + "%deleted_at = now()%", 1,
                order + " " + parentKind + "/" + childKind + " parent DELETE must queue first");
              childPromise = request(spec.path + childId, {
                token: spec.token.token, csrf: spec.token.csrf, method: "DELETE",
                ...(childKind === "document" ? { idempotencyKey: idemKey } : {})
              });
              await waitForLockWait("%from public.lock_live_case_parents%", 1,
                order + " " + parentKind + "/" + childKind + " child DELETE must wait for parent lock");
            }
          } finally {
            if (blockerOpen) await blocker.query("rollback").catch(() => {});
            if (blocker) blocker.release();
          }
          const [parentResponse, childResponse] = await Promise.all([parentPromise, childPromise]);
          assert.equal(parentResponse.status, 204, order + " " + parentKind + "/" + childKind + " parent soft-delete should commit");
          if (order === "child-first") {
            assert.equal(childResponse.status, 204, "child-first " + parentKind + "/" + childKind + " DELETE may commit before parent");
            assert.ok((await pool.query("select deleted_at from " + spec.table + " where id=$1", [childId])).rows[0].deleted_at,
              "accepted child-first delete must persist its tombstone");
            assert.equal(Number((await pool.query(
              "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action='delete'",
              [ids.officeA, spec.entity, childId]
            )).rows[0].count), childDeleteAuditBefore + 1, "accepted child-first delete must have exactly one audit row");
          } else {
            assert.equal(childResponse.status, 404, "parent-first " + parentKind + "/" + childKind + " DELETE must reject after parent commits");
            assert.equal((await pool.query("select deleted_at from " + spec.table + " where id=$1", [childId])).rows[0].deleted_at, null,
              "rejected parent-first child DELETE must not change the child tombstone");
            assert.equal(Number((await pool.query(
              "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action='delete'",
              [ids.officeA, spec.entity, childId]
            )).rows[0].count), childDeleteAuditBefore, "rejected parent-first child DELETE must not add audit");
            if (childKind === "document") {
              assert.equal(Number((await pool.query(
                "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
                [ids.officeA, spec.token.userId, idemKey]
              )).rows[0].count), 0, "rejected parent-first document DELETE must roll back idempotency reservation");
            }
          }
          assert.ok((await pool.query("select deleted_at from " + parentTable + " where id=$1", [parentId])).rows[0].deleted_at,
            "parent tombstone must persist in both lock orderings");
          assert.equal(Number((await pool.query(
            "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action='delete'",
            [ids.officeA, parentKind, parentId]
          )).rows[0].count), parentDeleteAuditBefore + 1, "parent deletion must write exactly one audit row");
        }
      }
    }
  } finally {
    await pool.query("drop trigger if exists pause_hearing_soft_delete_race on hearings").catch(() => {});
    await pool.query("drop trigger if exists pause_action_soft_delete_race on case_actions").catch(() => {});
    await pool.query("drop trigger if exists pause_document_soft_delete_race on case_documents").catch(() => {});
    await pool.query("drop function if exists pause_child_soft_delete_race()").catch(() => {});
  }
  console.log("PASS: child DELETE vs case/client soft-delete races serialize in both lock orders; rejected deletes leave tombstones, audit, and document idempotency unchanged");





  // Case soft-delete races with hearing-time PATCH and hearing reassignment in
  // both lock orders. Use actual HTTP handlers and PostgreSQL row/advisory locks;
  // assert source/destination summaries and audit rows from the database.
  async function seedCaseHearingRace(label) {
    const clientId = crypto.randomUUID();
    const sourceCaseId = crypto.randomUUID();
    const targetCaseId = crypto.randomUUID();
    const hearingId = crypto.randomUUID();
    const prefix = "CASE-HEARING-RACE-" + crypto.randomBytes(5).toString("hex") + "-" + label;
    const originalAt = new Date(Date.now() + 10 * 86400000);
    await pool.query(
      "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual',$3,$4,$5,$5)",
      [clientId, ids.officeA, "Case hearing race " + label, "7" + String(Math.floor(Math.random() * 1000000000)).padStart(9, "0"), ids.userA]
    );
    await pool.query(
      "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Race source',$5,$6,$6),($7,$2,$3,$8,'Race target',null,$6,$6)",
      [sourceCaseId, ids.officeA, clientId, prefix + "-SOURCE", originalAt, ids.userA, targetCaseId, prefix + "-TARGET"]
    );
    await pool.query(
      "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,$4,'trial','scheduled',$5,$5)",
      [hearingId, ids.officeA, sourceCaseId, originalAt, ids.userA]
    );
    return { clientId, sourceCaseId, targetCaseId, hearingId, originalAt };
  }

  async function caseDeleteVsHearingPatch({ label, operation, lockOrder }) {
    const fixture = await seedCaseHearingRace(label + "-" + lockOrder);
    const newAt = new Date(fixture.originalAt.getTime() + 2 * 86400000);
    const auditBefore = {
      caseDelete: await auditCount("case", "delete"),
      hearingUpdate: await auditCount("hearing", "update")
    };
    const blocker = await pool.connect();
    let blockerOpen = false;
    let advisoryHeld = false;
    const advisoryPair = operation === "time" ? [880003, 31] : [880003, 32];
    const triggerName = "pause_case_hearing_race_" + operation;
    const functionName = "pause_case_hearing_race_" + operation + "_fn";
    let deletePromise;
    let patchPromise;
    try {
      if (lockOrder === "parent-first") {
        await blocker.query("begin");
        await blocker.query("select id from cases where id=$1 for update", [fixture.sourceCaseId]);
        blockerOpen = true;
        deletePromise = request("/api/cases/" + fixture.sourceCaseId, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, label + " parent DELETE queued first");
        patchPromise = request("/api/hearings/" + fixture.hearingId, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "PATCH",
          body: operation === "time" ? { hearing_at: newAt.toISOString() } : { case_id: fixture.targetCaseId }
        });
        await waitForLockWait("%from public.lock_live_case_parents%", 1, label + " hearing PATCH waits behind parent DELETE");
        await blocker.query("rollback");
        blockerOpen = false;
      } else {
        await blocker.query("select pg_advisory_lock($1,$2)", advisoryPair);
        advisoryHeld = true;
        await pool.query(
          "create or replace function " + functionName + "() returns trigger language plpgsql as $fn$ begin perform pg_advisory_xact_lock(" +
            advisoryPair[0] + "," + advisoryPair[1] + "); return new; end $fn$"
        );
        await pool.query(
          "create trigger " + triggerName + " before update on hearings for each row when (old.id = '" +
            fixture.hearingId + "'::uuid) execute function " + functionName + "()"
        );
        patchPromise = request("/api/hearings/" + fixture.hearingId, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf, method: "PATCH",
          body: operation === "time" ? { hearing_at: newAt.toISOString() } : { case_id: fixture.targetCaseId }
        });
        await waitForLockWait("%update hearings%", 1, label + " child PATCH paused after parent locks");
        deletePromise = request("/api/cases/" + fixture.sourceCaseId, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, label + " parent DELETE waits behind child PATCH");
        const unlocked = await blocker.query("select pg_advisory_unlock($1,$2) as unlocked", advisoryPair);
        assert.equal(unlocked.rows[0].unlocked, true, label + " advisory barrier must release");
        advisoryHeld = false;
      }
      const [deleteResult, patchResult] = await Promise.all([deletePromise, patchPromise]);
      assert.equal(deleteResult.status, 204, label + " parent soft-delete should commit in either lock order");
      if (lockOrder === "parent-first") {
        assert.equal(patchResult.status, 400, label + " child PATCH must reject a case deleted first");
        assert.deepEqual(patchResult.body, { error: operation === "time" ? "invalid_related_case" : "invalid_related_case" });
        assert.ok((await pool.query("select deleted_at from cases where id=$1", [fixture.sourceCaseId])).rows[0].deleted_at);
        const hearing = (await pool.query("select case_id,hearing_at from hearings where id=$1", [fixture.hearingId])).rows[0];
        assert.equal(hearing.case_id, fixture.sourceCaseId, label + " rejected PATCH must preserve source case assignment");
        assert.equal(hearing.hearing_at.getTime(), fixture.originalAt.getTime(), label + " rejected PATCH must preserve hearing time");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.sourceCaseId])).rows[0].next_hearing_at.getTime(),
          fixture.originalAt.getTime(), label + " rejected PATCH must preserve source next_hearing_at");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.targetCaseId])).rows[0].next_hearing_at, null,
          label + " rejected PATCH must preserve target next_hearing_at");
        assert.equal(await auditCount("hearing", "update"), auditBefore.hearingUpdate,
          label + " rejected PATCH must not emit a hearing audit row");
      } else {
        assert.equal(patchResult.status, 200, label + " child PATCH that acquired parent locks first must commit");
        assert.ok((await pool.query("select deleted_at from cases where id=$1", [fixture.sourceCaseId])).rows[0].deleted_at);
        const hearing = (await pool.query("select case_id,hearing_at from hearings where id=$1", [fixture.hearingId])).rows[0];
        if (operation === "time") {
          assert.equal(hearing.case_id, fixture.sourceCaseId);
          assert.equal(hearing.hearing_at.getTime(), newAt.getTime());
          assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.sourceCaseId])).rows[0].next_hearing_at.getTime(),
            newAt.getTime(), label + " source summary must atomically reflect changed time");
          assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.targetCaseId])).rows[0].next_hearing_at, null);
        } else {
          assert.equal(hearing.case_id, fixture.targetCaseId, label + " hearing must move to destination");
          assert.equal(hearing.hearing_at.getTime(), fixture.originalAt.getTime());
          assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.sourceCaseId])).rows[0].next_hearing_at, null,
            label + " source summary must clear after move");
          assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.targetCaseId])).rows[0].next_hearing_at.getTime(),
            fixture.originalAt.getTime(), label + " destination summary must reflect moved hearing");
        }
        assert.equal(await auditCount("hearing", "update"), auditBefore.hearingUpdate + 1,
          label + " committed PATCH must emit exactly one hearing audit row");
      }
      assert.equal(await auditCount("case", "delete"), auditBefore.caseDelete + 1,
        label + " committed case soft-delete must emit exactly one audit row");
    } finally {
      if (blockerOpen) await blocker.query("rollback").catch(() => {});
      if (advisoryHeld) await blocker.query("select pg_advisory_unlock($1,$2)", advisoryPair).catch(() => {});
      blocker.release();
      await pool.query("drop trigger if exists " + triggerName + " on hearings").catch(() => {});
      await pool.query("drop function if exists " + functionName + "()").catch(() => {});
    }
  }

  for (const operation of ["time", "move"]) {
    await caseDeleteVsHearingPatch({ label: "case soft-delete vs hearing " + operation, operation, lockOrder: "parent-first" });
    await caseDeleteVsHearingPatch({ label: "case soft-delete vs hearing " + operation, operation, lockOrder: "child-first" });
  }
  console.log("PASS: case soft-delete races with hearing-time PATCH and hearing reassignment in both lock orders; source/destination next_hearing_at and audit counts remain consistent");


  // Audit INSERT failure during hearing reassignment must roll back the child
  // relationship and both case-summary refreshes in one HTTP/PostgreSQL tx.
  const moveAuditClient = crypto.randomUUID();
  const moveAuditSourceCase = crypto.randomUUID();
  const moveAuditTargetCase = crypto.randomUUID();
  const moveAuditHearing = crypto.randomUUID();
  const moveAuditPrefix = "HEARING-MOVE-AUDIT-ROLLBACK-" + crypto.randomBytes(5).toString("hex");
  const moveAuditAt = new Date(Date.now() + 11 * 86400000);
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Hearing move audit rollback','6'||lpad(floor(random()*1000000000)::text,9,'0'),$3,$3)",
    [moveAuditClient, ids.officeA, ids.userA]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Audit rollback source',$5,$6,$6),($7,$2,$3,$8,'Audit rollback destination',null,$6,$6)",
    [moveAuditSourceCase, ids.officeA, moveAuditClient, moveAuditPrefix + "-SOURCE", moveAuditAt, ids.userA,
      moveAuditTargetCase, moveAuditPrefix + "-TARGET"]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,$4,'trial','scheduled',$5,$5)",
    [moveAuditHearing, ids.officeA, moveAuditSourceCase, moveAuditAt, ids.userA]
  );
  const moveAuditBefore = {
    hearingUpdate: await auditCount("hearing", "update"),
    caseDelete: await auditCount("case", "delete")
  };
  await pool.query(`
    create or replace function reject_hearing_move_audit_insert() returns trigger language plpgsql as $fn$
    begin
      if new.entity_type='hearing' and new.action='update' then
        raise exception 'forced hearing move audit INSERT failure';
      end if;
      return new;
    end;
    $fn$;
    create trigger reject_hearing_move_audit_insert_trigger before insert on audit_logs
      for each row execute function reject_hearing_move_audit_insert();
  `);
  try {
    const failedMoveForAudit = await request("/api/hearings/" + moveAuditHearing, {
      token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
      method: "PATCH", body: { case_id: moveAuditTargetCase }
    });
    assert.equal(failedMoveForAudit.status, 500, "hearing reassignment must fail when audit INSERT fails");
    assert.deepEqual(failedMoveForAudit.body, { error: "database_error" },
      "audit failure response must not disclose database exception details");
    const persistedMove = (await pool.query("select case_id,hearing_at from hearings where id=$1", [moveAuditHearing])).rows[0];
    assert.equal(persistedMove.case_id, moveAuditSourceCase, "failed reassignment must preserve hearing source case_id");
    assert.equal(persistedMove.hearing_at.getTime(), moveAuditAt.getTime(), "failed reassignment must preserve hearing time");
    assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [moveAuditSourceCase])).rows[0].next_hearing_at.getTime(),
      moveAuditAt.getTime(), "failed reassignment must roll back source summary refresh");
    assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [moveAuditTargetCase])).rows[0].next_hearing_at,
      null, "failed reassignment must roll back destination summary refresh");
    assert.equal(await auditCount("hearing", "update"), moveAuditBefore.hearingUpdate,
      "failed reassignment must leave no hearing update audit row");
    assert.equal(await auditCount("case", "delete"), moveAuditBefore.caseDelete,
      "failed reassignment must not create unrelated case-delete audit rows");
  } finally {
    await pool.query("drop trigger if exists reject_hearing_move_audit_insert_trigger on audit_logs").catch(() => {});
    await pool.query("drop function if exists reject_hearing_move_audit_insert()").catch(() => {});
  }
  console.log("PASS: hearing reassignment audit INSERT failure rolls back case_id, source/destination next_hearing_at, and audit atomically");

  // Destination case soft-delete vs hearing reassignment in both deterministic
  // queue orders. The move helper must lock both case UUIDs in sorted order and
  // then client parents; audit rows and summary state are read directly from PG.
  async function seedDestinationDeleteMove(label) {
    const clientId = crypto.randomUUID();
    const sourceCaseId = crypto.randomUUID();
    const targetCaseId = crypto.randomUUID();
    const hearingId = crypto.randomUUID();
    const prefix = "DEST-DELETE-HEARING-MOVE-" + crypto.randomBytes(5).toString("hex") + "-" + label;
    const hearingAt = new Date(Date.now() + 13 * 86400000);
    await pool.query(
      "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual',$3,'5'||lpad(floor(random()*1000000000)::text,9,'0'),$4,$4)",
      [clientId, ids.officeA, "Destination delete race " + label, ids.userA]
    );
    await pool.query(
      "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Move source',$5,$6,$6),($7,$2,$3,$8,'Move destination',null,$6,$6)",
      [sourceCaseId, ids.officeA, clientId, prefix + "-SOURCE", hearingAt, ids.userA, targetCaseId, prefix + "-TARGET"]
    );
    await pool.query(
      "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,$4,'trial','scheduled',$5,$5)",
      [hearingId, ids.officeA, sourceCaseId, hearingAt, ids.userA]
    );
    return { sourceCaseId, targetCaseId, hearingId, hearingAt };
  }

  async function destinationDeleteVsMove(lockOrder) {
    const fixture = await seedDestinationDeleteMove(lockOrder);
    const auditBefore = {
      caseDelete: await auditCount("case", "delete"),
      hearingUpdate: await auditCount("hearing", "update")
    };
    const blocker = await pool.connect();
    let blockerOpen = false;
    let advisoryHeld = false;
    const advisoryPair = [880004, lockOrder === "parent-first" ? 41 : 42];
    const triggerName = "pause_destination_delete_move_" + lockOrder.replace("-", "_");
    const functionName = triggerName + "_fn";
    let deletePromise;
    let movePromise;
    try {
      if (lockOrder === "parent-first") {
        await blocker.query("begin");
        await blocker.query("select id from cases where id=$1 for update", [fixture.targetCaseId]);
        blockerOpen = true;
        deletePromise = request("/api/cases/" + fixture.targetCaseId, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, "destination case DELETE queued first");
        movePromise = request("/api/hearings/" + fixture.hearingId, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.targetCaseId }
        });
        await waitForLockWait("%from public.lock_live_case_parents%", 1, "hearing move waits behind destination DELETE");
        await blocker.query("rollback");
        blockerOpen = false;
      } else {
        await blocker.query("select pg_advisory_lock($1,$2)", advisoryPair);
        advisoryHeld = true;
        await pool.query(
          "create or replace function " + functionName + "() returns trigger language plpgsql as $fn$ begin perform pg_advisory_xact_lock(" +
            advisoryPair[0] + "," + advisoryPair[1] + "); return new; end $fn$"
        );
        await pool.query(
          "create trigger " + triggerName + " before update on hearings for each row when (old.id = '" +
            fixture.hearingId + "'::uuid) execute function " + functionName + "()"
        );
        movePromise = request("/api/hearings/" + fixture.hearingId, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.targetCaseId }
        });
        await waitForLockWait("%update hearings%", 1, "hearing move paused after ordered parent locks");
        deletePromise = request("/api/cases/" + fixture.targetCaseId, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, "destination DELETE waits behind hearing move");
        const unlocked = await blocker.query("select pg_advisory_unlock($1,$2) as unlocked", advisoryPair);
        assert.equal(unlocked.rows[0].unlocked, true, "must release hearing move barrier");
        advisoryHeld = false;
      }
      const [deleteResult, moveResult] = await Promise.all([deletePromise, movePromise]);
      assert.equal(deleteResult.status, 204, "destination soft-delete should commit in either lock order");
      if (lockOrder === "parent-first") {
        assert.equal(moveResult.status, 400, "hearing move must reject destination deleted first");
        assert.deepEqual(moveResult.body, { error: "invalid_related_case" });
        const hearing = (await pool.query("select case_id from hearings where id=$1", [fixture.hearingId])).rows[0];
        assert.equal(hearing.case_id, fixture.sourceCaseId, "rejected move must preserve source relationship");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.sourceCaseId])).rows[0].next_hearing_at.getTime(),
          fixture.hearingAt.getTime(), "rejected move must preserve source summary");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.targetCaseId])).rows[0].next_hearing_at,
          null, "rejected move must not update destination summary");
        assert.equal(await auditCount("hearing", "update"), auditBefore.hearingUpdate,
          "rejected move must not write hearing audit");
      } else {
        assert.equal(moveResult.status, 200, "hearing move that locks live parents first should commit");
        const hearing = (await pool.query("select case_id from hearings where id=$1", [fixture.hearingId])).rows[0];
        assert.equal(hearing.case_id, fixture.targetCaseId, "child-first move must persist destination case_id");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.sourceCaseId])).rows[0].next_hearing_at,
          null, "successful move must clear source summary");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.targetCaseId])).rows[0].next_hearing_at.getTime(),
          fixture.hearingAt.getTime(), "successful move must refresh destination summary");
        assert.equal(await auditCount("hearing", "update"), auditBefore.hearingUpdate + 1,
          "successful move must write exactly one hearing audit row");
      }
      assert.equal(await auditCount("case", "delete"), auditBefore.caseDelete + 1,
        "successful destination DELETE must write exactly one case audit row");
      assert.ok((await pool.query("select deleted_at from cases where id=$1", [fixture.targetCaseId])).rows[0].deleted_at,
        "destination case tombstone must persist");
    } finally {
      if (blockerOpen) await blocker.query("rollback").catch(() => {});
      if (advisoryHeld) await blocker.query("select pg_advisory_unlock($1,$2)", advisoryPair).catch(() => {});
      blocker.release();
      await pool.query("drop trigger if exists " + triggerName + " on hearings").catch(() => {});
      await pool.query("drop function if exists " + functionName + "()").catch(() => {});
    }
  }
  await destinationDeleteVsMove("parent-first");
  await destinationDeleteVsMove("child-first");
  console.log("PASS: destination case soft-delete vs hearing reassignment serializes in both lock orders; ordered parent locks, source/destination summaries, and audit counts stay consistent");


  // Inverse lock order for the source-parent race: the hearing move acquires
  // both parent rows first, with destination UUID sorting before source UUID;
  // source soft-delete must queue and commit only after move + summaries + audit.
  const sourceFirstIds = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const sourceFirstTargetCase = sourceFirstIds[0];
  const sourceFirstSourceCase = sourceFirstIds[1];
  assert.ok(sourceFirstTargetCase.localeCompare(sourceFirstSourceCase) < 0,
    "fixture must force destination UUID to sort before source UUID");
  const sourceFirstClient = crypto.randomUUID();
  const sourceFirstHearing = crypto.randomUUID();
  const sourceFirstPrefix = "SOURCE-DELETE-CHILD-FIRST-" + crypto.randomBytes(5).toString("hex");
  const sourceFirstAt = new Date(Date.now() + 15 * 86400000);
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Source child-first race','4'||lpad(floor(random()*1000000000)::text,9,'0'),$3,$3)",
    [sourceFirstClient, ids.officeA, ids.userA]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Source case deleted after move',$5,$6,$6),($7,$2,$3,$8,'Live destination case',null,$6,$6)",
    [sourceFirstSourceCase, ids.officeA, sourceFirstClient, sourceFirstPrefix + "-SOURCE", sourceFirstAt, ids.userA,
      sourceFirstTargetCase, sourceFirstPrefix + "-TARGET"]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,$4,'trial','scheduled',$5,$5)",
    [sourceFirstHearing, ids.officeA, sourceFirstSourceCase, sourceFirstAt, ids.userA]
  );
  const sourceFirstAuditBefore = {
    caseDelete: await auditCount("case", "delete"),
    hearingUpdate: await auditCount("hearing", "update")
  };
  const sourceFirstGate = await pool.connect();
  let sourceFirstAdvisoryHeld = false;
  const sourceFirstAdvisory = [880005, 51];
  const sourceFirstTrigger = "pause_source_delete_child_first_hearing";
  const sourceFirstFunction = sourceFirstTrigger + "_fn";
  let sourceFirstMovePromise;
  let sourceFirstDeletePromise;
  try {
    await sourceFirstGate.query("select pg_advisory_lock($1,$2)", sourceFirstAdvisory);
    sourceFirstAdvisoryHeld = true;
    await pool.query(
      "create or replace function " + sourceFirstFunction + "() returns trigger language plpgsql as $fn$ begin perform pg_advisory_xact_lock(" +
        sourceFirstAdvisory[0] + "," + sourceFirstAdvisory[1] + "); return new; end $fn$"
    );
    await pool.query(
      "create trigger " + sourceFirstTrigger + " before update on hearings for each row when (old.id = '" +
        sourceFirstHearing + "'::uuid) execute function " + sourceFirstFunction + "()"
    );
    sourceFirstMovePromise = request("/api/hearings/" + sourceFirstHearing, {
      token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
      method: "PATCH", body: { case_id: sourceFirstTargetCase }
    });
    await waitForLockWait("%update hearings%", 1, "source-first child-first hearing move paused after UUID-ordered parent locks");
    sourceFirstDeletePromise = request("/api/cases/" + sourceFirstSourceCase, {
      token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
    });
    await waitForLockWait("%update cases%deleted_at = now()%", 1, "source DELETE queued behind hearing move");
    const sourceFirstUnlock = await sourceFirstGate.query(
      "select pg_advisory_unlock($1,$2) as unlocked", sourceFirstAdvisory
    );
    assert.equal(sourceFirstUnlock.rows[0].unlocked, true, "source child-first barrier must release");
    sourceFirstAdvisoryHeld = false;
    const [sourceFirstMoveResult, sourceFirstDeleteResult] = await Promise.all([
      sourceFirstMovePromise, sourceFirstDeletePromise
    ]);
    assert.equal(sourceFirstMoveResult.status, 200, "hearing move holding both parent locks must commit first");
    assert.equal(sourceFirstDeleteResult.status, 204, "queued source soft-delete must commit after the move");
    assert.ok((await pool.query("select deleted_at from cases where id=$1", [sourceFirstSourceCase])).rows[0].deleted_at,
      "source case soft-delete must persist after transfer");
    const sourceFirstHearingRow = (await pool.query(
      "select case_id,hearing_at from hearings where id=$1", [sourceFirstHearing]
    )).rows[0];
    assert.equal(sourceFirstHearingRow.case_id, sourceFirstTargetCase,
      "hearing must remain linked to the live destination after source deletion");
    assert.equal(sourceFirstHearingRow.hearing_at.getTime(), sourceFirstAt.getTime(),
      "moving a hearing must preserve its scheduled time");
    assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [sourceFirstSourceCase])).rows[0].next_hearing_at,
      null, "source summary must be cleared by the committed move before source deletion");
    assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [sourceFirstTargetCase])).rows[0].next_hearing_at.getTime(),
      sourceFirstAt.getTime(), "destination summary must reflect the transferred hearing");
    assert.equal(await auditCount("hearing", "update"), sourceFirstAuditBefore.hearingUpdate + 1,
      "successful move must commit exactly one hearing-update audit row");
    assert.equal(await auditCount("case", "delete"), sourceFirstAuditBefore.caseDelete + 1,
      "successful source delete must commit exactly one case-delete audit row");
  } finally {
    if (sourceFirstAdvisoryHeld) await sourceFirstGate.query(
      "select pg_advisory_unlock($1,$2)", sourceFirstAdvisory
    ).catch(() => {});
    sourceFirstGate.release();
    await pool.query("drop trigger if exists " + sourceFirstTrigger + " on hearings").catch(() => {});
    await pool.query("drop function if exists " + sourceFirstFunction + "()").catch(() => {});
  }
  console.log("PASS: source case soft-delete vs hearing move child-first with inverted UUID order; move/audit commit before delete and source/destination summaries stay consistent");


  // Combined race: two hearings attempt opposite-direction moves while one
  // parent case is soft-deleted. Use ordered UUIDs so both moves lock A before B.
  // Exercise both delete-first and move-first orderings with PostgreSQL barriers.
  async function seedOppositeMoveDeleteRace(label) {
    const orderedCaseIds = [crypto.randomUUID(), crypto.randomUUID()].sort();
    const caseA = orderedCaseIds[0];
    const caseB = orderedCaseIds[1];
    assert.ok(caseA.localeCompare(caseB) < 0, "case A UUID must sort before case B");
    const clientId = crypto.randomUUID();
    const hearingA = crypto.randomUUID();
    const hearingB = crypto.randomUUID();
    const prefix = "OPPOSITE-MOVES-DELETE-" + crypto.randomBytes(5).toString("hex") + "-" + label;
    const timeA = new Date(Date.now() + 6 * 86400000);
    const timeB = new Date(Date.now() + 9 * 86400000);
    await pool.query(
      "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual',$3,'6'||lpad(floor(random()*1000000000)::text,9,'0'),$4,$4)",
      [clientId, ids.officeA, "Opposite move soft-delete race " + label, ids.userA]
    );
    await pool.query(
      "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Case A',$5,$6,$6),($7,$2,$3,$8,'Case B',$9,$6,$6)",
      [caseA, ids.officeA, clientId, prefix + "-A", timeA, ids.userA, caseB, prefix + "-B", timeB]
    );
    await pool.query(
      "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values($1,$2,$3,$4,'trial','scheduled',$5,$5),($6,$2,$7,$8,'trial','scheduled',$5,$5)",
      [hearingA, ids.officeA, caseA, timeA, ids.userA, hearingB, caseB, timeB]
    );
    return { caseA, caseB, hearingA, hearingB, timeA, timeB };
  }

  async function runOppositeMoveDeleteRace(lockOrder) {
    const fixture = await seedOppositeMoveDeleteRace(lockOrder);
    const auditBefore = {
      caseDelete: Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case' and entity_id=$2 and action='delete'",
        [ids.officeA, fixture.caseA]
      )).rows[0].count),
      hearingUpdates: Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=any($2::uuid[]) and action='update'",
        [ids.officeA, [fixture.hearingA, fixture.hearingB]]
      )).rows[0].count)
    };
    let deleteResult;
    let moveAToBResult;
    let moveBToAResult;
    const blocker = await pool.connect();
    let blockerOpen = false;
    let advisoryHeld = false;
    const advisory = [880006, 61];
    const triggerName = "pause_opposite_move_delete_race";
    const functionName = triggerName + "_fn";
    let deletePromise;
    let moveAToBPromise;
    let moveBToAPromise;
    try {
      if (lockOrder === "parent-first") {
        await blocker.query("begin");
        await blocker.query("select id from cases where id=$1 for update", [fixture.caseA]);
        blockerOpen = true;
        deletePromise = request("/api/cases/" + fixture.caseA, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, "case A DELETE queued before opposite moves");
        moveAToBPromise = request("/api/hearings/" + fixture.hearingA, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.caseB }
        });
        moveBToAPromise = request("/api/hearings/" + fixture.hearingB, {
          token: tokenA, csrf: csrfA, method: "PATCH", body: { case_id: fixture.caseA }
        });
        await waitForLockWait("%from public.lock_live_case_parents%", 2, "both opposite moves queued behind case A DELETE");
        await blocker.query("rollback");
        blockerOpen = false;
      } else {
        await blocker.query("select pg_advisory_lock($1,$2)", advisory);
        advisoryHeld = true;
        await pool.query(
          "create or replace function " + functionName + "() returns trigger language plpgsql as $fn$ begin perform pg_advisory_xact_lock(" +
            advisory[0] + "," + advisory[1] + "); return new; end $fn$"
        );
        await pool.query(
          "create trigger " + triggerName + " before update on hearings for each row when (old.id = '" +
            fixture.hearingA + "'::uuid) execute function " + functionName + "()"
        );
        moveAToBPromise = request("/api/hearings/" + fixture.hearingA, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.caseB }
        });
        await waitForLockWait("%update hearings%", 1, "A-to-B move paused after acquiring ordered A/B parent locks");
        deletePromise = request("/api/cases/" + fixture.caseA, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, "case A DELETE queued behind first move");
        moveBToAPromise = request("/api/hearings/" + fixture.hearingB, {
          token: tokenA, csrf: csrfA, method: "PATCH", body: { case_id: fixture.caseA }
        });
        await waitForLockWait("%from public.lock_live_case_parents%", 1, "B-to-A move queued behind delete in UUID order");
        const unlocked = await blocker.query("select pg_advisory_unlock($1,$2) as unlocked", advisory);
        assert.equal(unlocked.rows[0].unlocked, true, "opposite-move advisory barrier must release");
        advisoryHeld = false;
      }

      [deleteResult, moveAToBResult, moveBToAResult] = await Promise.all([
        deletePromise, moveAToBPromise, moveBToAPromise
      ]);
      assert.equal(deleteResult.status, 204, "case A soft-delete must commit");
      assert.equal((await pool.query("select deleted_at from cases where id=$1", [fixture.caseA])).rows[0].deleted_at !== null, true);
      const hearingRows = (await pool.query(
        "select id,case_id,hearing_at from hearings where id=any($1::uuid[]) order by id",
        [[fixture.hearingA, fixture.hearingB]]
      )).rows;
      const hearingA = hearingRows.find(row => row.id === fixture.hearingA);
      const hearingB = hearingRows.find(row => row.id === fixture.hearingB);
      assert.equal(hearingA.hearing_at.getTime(), fixture.timeA.getTime(), "hearing A time must never change in a move race");
      assert.equal(hearingB.hearing_at.getTime(), fixture.timeB.getTime(), "hearing B time must never change in a move race");

      if (lockOrder === "parent-first") {
        assert.equal(moveAToBResult.status, 400, "A-to-B move must reject after A is deleted");
        assert.deepEqual(moveAToBResult.body, { error: "invalid_related_case" });
        assert.equal(moveBToAResult.status, 400, "B-to-A move must reject because destination A is deleted");
        assert.deepEqual(moveBToAResult.body, { error: "invalid_related_case" });
        assert.equal(hearingA.case_id, fixture.caseA, "rejected A-to-B move must preserve original case_id");
        assert.equal(hearingB.case_id, fixture.caseB, "rejected B-to-A move must preserve original case_id");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.caseA])).rows[0].next_hearing_at.getTime(),
          fixture.timeA.getTime(), "parent-first rejection must not mutate deleted A's stored summary");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.caseB])).rows[0].next_hearing_at.getTime(),
          fixture.timeB.getTime(), "parent-first rejection must not mutate B's summary");
        assert.equal(Number((await pool.query(
          "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=any($2::uuid[]) and action='update'",
          [ids.officeA, [fixture.hearingA, fixture.hearingB]]
        )).rows[0].count), auditBefore.hearingUpdates, "rejected moves must emit no hearing-update audit rows");
      } else {
        assert.equal(moveAToBResult.status, 200, "first A-to-B move must commit while holding ordered parent locks");
        assert.equal(moveBToAResult.status, 400, "queued B-to-A move must reject after queued A delete commits");
        assert.deepEqual(moveBToAResult.body, { error: "invalid_related_case" });
        assert.equal(hearingA.case_id, fixture.caseB, "first hearing must remain moved to B");
        assert.equal(hearingB.case_id, fixture.caseB, "reverse move must leave second hearing on B");
        assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [fixture.caseA])).rows[0].next_hearing_at,
          null, "source A summary must clear after the committed first move");
        const summaryB = (await pool.query("select next_hearing_at from cases where id=$1", [fixture.caseB])).rows[0].next_hearing_at;
        const expectedB = (await pool.query(
          "select min(hearing_at) as expected from hearings where office_id=$1 and case_id=$2 and deleted_at is null and status in ('scheduled','postponed') and hearing_at>=now()",
          [ids.officeA, fixture.caseB]
        )).rows[0].expected;
        assert.equal(summaryB?.getTime(), expectedB?.getTime(), "B summary must match the final live hearing assignment");
        assert.equal(summaryB.getTime(), fixture.timeA.getTime(), "earlier transferred hearing must become B's next hearing");
        assert.equal(Number((await pool.query(
          "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=any($2::uuid[]) and action='update'",
          [ids.officeA, [fixture.hearingA, fixture.hearingB]]
        )).rows[0].count), auditBefore.hearingUpdates + 1,
        "only the committed A-to-B move may emit a hearing-update audit row");
      }
      assert.equal(Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case' and entity_id=$2 and action='delete'",
        [ids.officeA, fixture.caseA]
      )).rows[0].count), auditBefore.caseDelete + 1, "case A deletion must emit exactly one audit row");
    } finally {
      if (blockerOpen) await blocker.query("rollback").catch(() => {});
      if (advisoryHeld) await blocker.query("select pg_advisory_unlock($1,$2)", advisory).catch(() => {});
      blocker.release();
      await pool.query("drop trigger if exists " + triggerName + " on hearings").catch(() => {});
      await pool.query("drop function if exists " + functionName + "()").catch(() => {});
    }
  }

  await runOppositeMoveDeleteRace("parent-first");
  await runOppositeMoveDeleteRace("child-first");
  console.log("PASS: opposite-direction hearing moves race with case soft-delete in both lock orders; UUID ordering, summaries, and exact audit counts remain consistent without deadlock");


  // Three-way race: multiple hearings move in opposite directions while both
  // parent cases are soft-deleted. Exercise deterministic queue order and a
  // real lock_timeout rollback using the isolated timeout-configured API server.
  async function seedDualCaseDeleteMultiHearingRace(label) {
    const ordered = [crypto.randomUUID(), crypto.randomUUID()].sort();
    const caseA = ordered[0];
    const caseB = ordered[1];
    assert.ok(caseA.localeCompare(caseB) < 0, "fixture must establish UUID lock order A before B");
    const clientId = crypto.randomUUID();
    const hearingA1 = crypto.randomUUID();
    const hearingA2 = crypto.randomUUID();
    const hearingB1 = crypto.randomUUID();
    const prefix = "DUAL-DELETE-MULTI-MOVE-" + crypto.randomBytes(5).toString("hex") + "-" + label;
    const times = [
      new Date(Date.now() + 4 * 86400000),
      new Date(Date.now() + 7 * 86400000),
      new Date(Date.now() + 10 * 86400000)
    ];
    await pool.query(
      "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual',$3,'7'||lpad(floor(random()*1000000000)::text,9,'0'),$4,$4)",
      [clientId, ids.officeA, "Dual case delete race " + label, ids.userA]
    );
    await pool.query(
      "insert into cases(id,office_id,client_id,case_number,title,next_hearing_at,created_by,updated_by) values($1,$2,$3,$4,'Case A',$5,$6,$6),($7,$2,$3,$8,'Case B',$9,$6,$6)",
      [caseA, ids.officeA, clientId, prefix + "-A", times[0], ids.userA, caseB, prefix + "-B", times[2]]
    );
    await pool.query(
      "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,created_by,updated_by) values" +
      "($1,$2,$3,$4,'trial','scheduled',$5,$5),($6,$2,$3,$7,'trial','scheduled',$5,$5),($8,$2,$9,$10,'trial','scheduled',$5,$5)",
      [hearingA1, ids.officeA, caseA, times[0], ids.userA, hearingA2, times[1], hearingB1, caseB, times[2]]
    );
    return { caseA, caseB, hearingA1, hearingA2, hearingB1, times };
  }

  async function runDualCaseDeleteMultiHearingRace(ordering) {
    const fixture = await seedDualCaseDeleteMultiHearingRace(ordering);
    const auditBefore = {
      caseADelete: Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case' and entity_id=$2 and action='delete'",
        [ids.officeA, fixture.caseA]
      )).rows[0].count),
      caseBDelete: Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case' and entity_id=$2 and action='delete'",
        [ids.officeA, fixture.caseB]
      )).rows[0].count),
      hearingUpdates: Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=any($2::uuid[]) and action='update'",
        [ids.officeA, [fixture.hearingA1, fixture.hearingA2, fixture.hearingB1]]
      )).rows[0].count)
    };
    const blocker = await pool.connect();
    const advisory = [880007, ordering === "parent-first" ? 71 : 72];
    const triggerName = "pause_dual_case_delete_multi_move";
    const functionName = triggerName + "_fn";
    let blockerOpen = false;
    let advisoryHeld = false;
    let deleteAPromise;
    let deleteBPromise;
    let moveA1Promise;
    let moveA2Promise;
    let moveB1Promise;
    try {
      if (ordering === "parent-first") {
        await blocker.query("begin");
        await blocker.query("select id from cases where id=any($1::uuid[]) order by id for update", [[fixture.caseA, fixture.caseB]]);
        blockerOpen = true;
        deleteAPromise = request("/api/cases/" + fixture.caseA, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, "first case DELETE waits on UUID-ordered blocker");
        deleteBPromise = request("/api/cases/" + fixture.caseB, {
          token: raceActors["case-patch"].token, csrf: raceActors["case-patch"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 2, "both case DELETE requests are queued");
        moveA1Promise = request("/api/hearings/" + fixture.hearingA1, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.caseB }
        });
        moveA2Promise = request("/api/hearings/" + fixture.hearingA2, {
          token: raceActors["hearing-create"].token, csrf: raceActors["hearing-create"].csrf,
          method: "PATCH", body: { case_id: fixture.caseB }
        });
        moveB1Promise = request("/api/hearings/" + fixture.hearingB1, {
          token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.caseA }
        });
        await waitForLockWait("%from public.lock_live_case_parents%", 3, "all three hearing moves queue behind both case deletions");
        await blocker.query("rollback");
        blockerOpen = false;
      } else {
        await blocker.query("select pg_advisory_lock($1,$2)", advisory);
        advisoryHeld = true;
        await pool.query(
          "create or replace function " + functionName + "() returns trigger language plpgsql as $fn$ begin perform pg_advisory_xact_lock(" +
            advisory[0] + "," + advisory[1] + "); return new; end $fn$"
        );
        await pool.query(
          "create trigger " + triggerName + " before update on hearings for each row when (old.id = '" +
            fixture.hearingA1 + "'::uuid) execute function " + functionName + "()"
        );
        moveA1Promise = request("/api/hearings/" + fixture.hearingA1, {
          token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.caseB }
        });
        await waitForLockWait("%update hearings%", 1, "first hearing move paused after locking A and B in UUID order");
        deleteAPromise = request("/api/cases/" + fixture.caseA, {
          token: raceActors["case-delete"].token, csrf: raceActors["case-delete"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 1, "case A delete queued behind first move");
        deleteBPromise = request("/api/cases/" + fixture.caseB, {
          token: raceActors["case-patch"].token, csrf: raceActors["case-patch"].csrf, method: "DELETE"
        });
        await waitForLockWait("%update cases%deleted_at = now()%", 2, "both case deletions queued behind first move");
        moveA2Promise = request("/api/hearings/" + fixture.hearingA2, {
          token: raceActors["hearing-create"].token, csrf: raceActors["hearing-create"].csrf,
          method: "PATCH", body: { case_id: fixture.caseB }
        });
        moveB1Promise = request("/api/hearings/" + fixture.hearingB1, {
          token: raceActors["action-patch"].token, csrf: raceActors["action-patch"].csrf,
          method: "PATCH", body: { case_id: fixture.caseA }
        });
        await waitForLockWait("%from public.lock_live_case_parents%", 2, "remaining hearing moves queue behind UUID-ordered case locks");
        const unlocked = await blocker.query("select pg_advisory_unlock($1,$2) as unlocked", advisory);
        assert.equal(unlocked.rows[0].unlocked, true, "multi-hearing barrier must release");
        advisoryHeld = false;
      }

      const [deleteA, deleteB, moveA1, moveA2, moveB1] = await Promise.all([
        deleteAPromise, deleteBPromise, moveA1Promise, moveA2Promise, moveB1Promise
      ]);
      assert.equal(deleteA.status, 204, "case A soft-delete must commit");
      assert.equal(deleteB.status, 204, "case B soft-delete must commit");
      const cases = (await pool.query(
        "select id,deleted_at,next_hearing_at from cases where id=any($1::uuid[]) order by id",
        [[fixture.caseA, fixture.caseB]]
      )).rows;
      assert.equal(cases.length, 2);
      assert.ok(cases.every(row => row.deleted_at !== null), "both case tombstones must persist");
      const hearings = (await pool.query(
        "select id,case_id,hearing_at from hearings where id=any($1::uuid[])",
        [[fixture.hearingA1, fixture.hearingA2, fixture.hearingB1]]
      )).rows;
      const rowA1 = hearings.find(row => row.id === fixture.hearingA1);
      const rowA2 = hearings.find(row => row.id === fixture.hearingA2);
      const rowB1 = hearings.find(row => row.id === fixture.hearingB1);
      assert.deepEqual(
        [rowA1.hearing_at.getTime(), rowA2.hearing_at.getTime(), rowB1.hearing_at.getTime()],
        fixture.times.map(time => time.getTime()),
        "every hearing_at must survive concurrent moves and deletions unchanged"
      );

      if (ordering === "parent-first") {
        for (const result of [moveA1, moveA2, moveB1]) {
          assert.equal(result.status, 400, "each move must reject when both parent cases were deleted first");
          assert.deepEqual(result.body, { error: "invalid_related_case" });
        }
        assert.deepEqual([rowA1.case_id, rowA2.case_id, rowB1.case_id],
          [fixture.caseA, fixture.caseA, fixture.caseB], "parent-first rejection must preserve all original case_id values");
        assert.deepEqual(cases.map(row => row.next_hearing_at?.getTime() ?? null),
          [fixture.times[0].getTime(), fixture.times[2].getTime()],
          "rejected moves must not mutate either case's pre-existing summary");
        assert.equal(Number((await pool.query(
          "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=any($2::uuid[]) and action='update'",
          [ids.officeA, [fixture.hearingA1, fixture.hearingA2, fixture.hearingB1]]
        )).rows[0].count), auditBefore.hearingUpdates, "all rejected moves must leave hearing audit unchanged");
      } else {
        assert.equal(moveA1.status, 200, "first A-to-B transfer must commit before both deletions");
        assert.equal(moveA2.status, 400, "queued A-to-B transfer must reject once destination B is deleted");
        assert.deepEqual(moveA2.body, { error: "invalid_related_case" });
        assert.equal(moveB1.status, 400, "queued B-to-A transfer must reject once destination A is deleted");
        assert.deepEqual(moveB1.body, { error: "invalid_related_case" });
        assert.deepEqual([rowA1.case_id, rowA2.case_id, rowB1.case_id],
          [fixture.caseB, fixture.caseA, fixture.caseB],
          "only the first move may change case_id; rejected moves preserve their original links");
        assert.equal(cases.find(row => row.id === fixture.caseA).next_hearing_at, null,
          "source A summary must clear after the committed transfer");
        const summaryB = cases.find(row => row.id === fixture.caseB).next_hearing_at;
        assert.equal(summaryB?.getTime(), fixture.times[0].getTime(),
          "destination B summary must include the earliest transferred hearing");
        assert.equal(Number((await pool.query(
          "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=any($2::uuid[]) and action='update'",
          [ids.officeA, [fixture.hearingA1, fixture.hearingA2, fixture.hearingB1]]
        )).rows[0].count), auditBefore.hearingUpdates + 1,
        "only the committed transfer may leave a hearing-update audit row");
      }
      assert.equal(Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case' and entity_id=$2 and action='delete'",
        [ids.officeA, fixture.caseA]
      )).rows[0].count), auditBefore.caseADelete + 1, "case A deletion audit must commit exactly once");
      assert.equal(Number((await pool.query(
        "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case' and entity_id=$2 and action='delete'",
        [ids.officeA, fixture.caseB]
      )).rows[0].count), auditBefore.caseBDelete + 1, "case B deletion audit must commit exactly once");
    } finally {
      if (blockerOpen) await blocker.query("rollback").catch(() => {});
      if (advisoryHeld) await blocker.query("select pg_advisory_unlock($1,$2)", advisory).catch(() => {});
      blocker.release();
      await pool.query("drop trigger if exists " + triggerName + " on hearings").catch(() => {});
      await pool.query("drop function if exists " + functionName + "()").catch(() => {});
    }
  }

  await runDualCaseDeleteMultiHearingRace("parent-first");
  await runDualCaseDeleteMultiHearingRace("child-first");

  // A real lock_timeout on the dedicated timeout server must roll back the
  // hearing reassignment, both parent summaries, and its audit event together.
  const timeoutFixture = await seedDualCaseDeleteMultiHearingRace("lock-timeout");
  const timeoutAuditBefore = Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=$2 and action='update'",
    [ids.officeA, timeoutFixture.hearingA1]
  )).rows[0].count);
  const timeoutBlocker = await pool.connect();
  let timeoutBlockerOpen = false;
  let timeoutMovePromise;
  try {
    await timeoutBlocker.query("begin");
    await timeoutBlocker.query("select id from cases where id=$1 for update", [timeoutFixture.caseA]);
    timeoutBlockerOpen = true;
    timeoutMovePromise = request("/api/hearings/" + timeoutFixture.hearingA1, {
      token: raceActors["hearing-patch"].token, csrf: raceActors["hearing-patch"].csrf,
      method: "PATCH", portToUse: timeoutPort, body: { case_id: timeoutFixture.caseB }
    });
    await waitForLockWait("%from public.lock_live_case_parents%", 1, "hearing move waits on locked parent before lock_timeout");
    const timeoutResponse = await timeoutMovePromise;
    assert.equal(timeoutResponse.status, 503, "parent-row lock_timeout must return retryable 503");
    assert.deepEqual(timeoutResponse.body, { error: "database_retryable" });
  } finally {
    if (timeoutBlockerOpen) await timeoutBlocker.query("rollback").catch(() => {});
    if (timeoutMovePromise) await timeoutMovePromise.catch(() => {});
    timeoutBlocker.release();
  }
  const timeoutHearing = (await pool.query(
    "select case_id,hearing_at from hearings where id=$1", [timeoutFixture.hearingA1]
  )).rows[0];
  assert.equal(timeoutHearing.case_id, timeoutFixture.caseA, "timed-out move must roll back hearing assignment");
  assert.equal(timeoutHearing.hearing_at.getTime(), timeoutFixture.times[0].getTime(), "timed-out move must preserve hearing time");
  assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [timeoutFixture.caseA])).rows[0].next_hearing_at.getTime(),
    timeoutFixture.times[0].getTime(), "timed-out move must preserve source summary");
  assert.equal((await pool.query("select next_hearing_at from cases where id=$1", [timeoutFixture.caseB])).rows[0].next_hearing_at.getTime(),
    timeoutFixture.times[2].getTime(), "timed-out move must preserve destination summary");
  assert.equal(Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='hearing' and entity_id=$2 and action='update'",
    [ids.officeA, timeoutFixture.hearingA1]
  )).rows[0].count), timeoutAuditBefore, "timed-out move must leave no audit row");
  console.log("PASS: dual case soft-delete vs multiple opposite-direction hearing moves in both lock orders; lock_timeout rolls back assignment, summaries, and audit atomically");

} catch (error) {
  console.error(error);
  if (server) console.error(serverOutput);
  if (auditServer) console.error(auditServerOutput);
  if (outageServer) console.error(outageServerOutput);
  process.exitCode = 1;
} finally {
  await pool.query("drop trigger if exists fail_transient_document_mutations_trigger on case_documents").catch(()=>{});
  await pool.query("drop trigger if exists pause_session_revoke_race_trigger on case_documents").catch(()=>{});
  await pool.query("drop function if exists pause_session_revoke_race()").catch(()=>{});
  await pool.query("drop function if exists fail_transient_document_mutations()").catch(()=>{});
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (auditServer && auditServer.exitCode === null) auditServer.kill("SIGTERM");
  if (outageServer && outageServer.exitCode === null) outageServer.kill("SIGTERM");
  if (timeoutServer && timeoutServer.exitCode === null) timeoutServer.kill("SIGTERM");
  if (rateLimitServer && rateLimitServer.exitCode === null) rateLimitServer.kill("SIGTERM");
  if (roleServer && roleServer.exitCode === null) roleServer.kill("SIGTERM");
  if (retryServer && retryServer.exitCode === null) retryServer.kill("SIGTERM");
  if (crashServer && crashServer.exitCode === null) crashServer.kill("SIGKILL");
  await pool.end();
}
