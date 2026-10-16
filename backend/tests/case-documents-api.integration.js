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
      deleted_at timestamptz, unique (id, office_id)
    );
    create table hearings (
      id uuid primary key default gen_random_uuid(), office_id uuid not null references offices(id),
      case_id uuid not null, hearing_at timestamptz not null, hearing_type text,
      court_name text, branch_name text, status text not null default 'scheduled',
      reminder_minutes integer, notes text, created_by uuid, updated_by uuid, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), deleted_at timestamptz
    );
    create table case_actions (
      id uuid primary key default gen_random_uuid(), office_id uuid not null references offices(id),
      case_id uuid not null, title text not null, description text, due_at timestamptz,
      status text not null default 'todo', priority text, assigned_to uuid,
      completed_at timestamptz, created_by uuid, updated_by uuid, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), deleted_at timestamptz
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
  retryServer = spawn(process.execPath, ["src/server.js"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, PORT: String(retryPort), NODE_ENV: "test", RATE_LIMIT_MODE: "memory", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin }, stdio: ["ignore", "pipe", "pipe"] });
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
        const waiting = await pool.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'select confidentiality from case_documents%'");
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
    env: { ...process.env, PORT: String(timeoutPort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin, DB_STATEMENT_TIMEOUT_MS: "750" },
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
  // Real row-lock contention (not a synthetic SQLSTATE): auth succeeds, but the
  // in-transaction actor revalidation waits on the user's row and hits statement_timeout.
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
      "a real actor-row lock wait that reaches statement_timeout must be explicitly retryable after rollback");
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
  console.log("PASS: real PostgreSQL actor-lock wait times out, rolls back without audit/idempotency residue, releases locks, and a fresh write succeeds");

  await pool.query("drop trigger delay_target_document_update_trigger on case_documents");
  await pool.query("drop function delay_target_document_update()");
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
        "select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'select confidentiality from case_documents%'"
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
