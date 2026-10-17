import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (!parsed || !["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/dadban_test") {
  throw new Error("Commit-outcome test may only use the dedicated disposable localhost /dadban_test database");
}

const apiPort = Number(process.env.DADBAN_COMMIT_TEST_PORT || 18147);
const proxyPort = Number(process.env.DADBAN_COMMIT_PROXY_PORT || 18148);
const origin = "http://localhost:5500";
const token = "test-session-office-a-".padEnd(48, "a");
const csrf = "test-csrf-office-a-".padEnd(48, "c");
const ids = {
  office: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  case: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02"
};
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 });

let armed = false;
let droppedCommitResponses = 0;
let proxy;
let server;
let serverOutput = "";

async function waitForServer(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Commit-outcome API did not become healthy");
}

async function request(path, { method, body, key, port = apiPort, sessionToken = token, csrfToken = csrf } = {}) {
  const headers = {
    origin,
    cookie: `dadban_session=${sessionToken}; dadban_csrf=${csrfToken}`,
    "x-csrf-token": csrfToken
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json()
  };
}

async function login(email, password, port = apiPort) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.json();
  assert.equal(response.status, 200, `fresh login should succeed for ${email}; got HTTP ${response.status}: ${JSON.stringify(body)}`);
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.find(value => value.startsWith("dadban_session="));
  const csrfCookie = cookies.find(value => value.startsWith("dadban_csrf="));
  assert.ok(sessionCookie && csrfCookie, "login must issue both authentication cookies");
  return {
    token: decodeURIComponent(sessionCookie.split(";", 1)[0].slice("dadban_session=".length)),
    csrf: body.data.csrf_token,
    user: body.data.user
  };
}

async function waitForCompletedKey(key, expectedStatus) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "select response_status from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
      [ids.office, ids.user, key]
    );
    if (result.rowCount === 1 && result.rows[0].response_status === expectedStatus) return;
    await delay(25);
  }
  throw new Error(`PostgreSQL did not expose committed idempotency result for ${key}`);
}

async function countAudit(documentId, action) {
  const result = await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2 and action=$3",
    [ids.office, documentId, action]
  );
  return result.rows[0].count;
}

async function countEntityAudit(entityType, entityId, action) {
  const result = await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action=$4",
    [ids.office, entityType, entityId, action]
  );
  return result.rows[0].count;
}

try {
  // A TCP proxy drops the PostgreSQL response only after forwarding COMMIT to the
  // disposable PostgreSQL service. The application must treat the result as unknown,
  // discard the broken connection, and resolve it through the durable same-key retry.
  proxy = net.createServer(client => {
    const upstream = net.connect(5432, "127.0.0.1");
    let frontendBuffer = Buffer.alloc(0);
    let startupComplete = false;
    let responseBuffer = Buffer.alloc(0);
    let responseParseOffset = 0;
    let dropThisCommitResponse = false;
    let sawCommitComplete = false;
    const queued = [];

    client.on("data", data => {
      frontendBuffer = Buffer.concat([frontendBuffer, data]);
      let offset = 0;
      while (true) {
        if (!startupComplete) {
          if (frontendBuffer.length - offset < 4) break;
          const startupLength = frontendBuffer.readInt32BE(offset);
          if (startupLength < 8 || frontendBuffer.length - offset < startupLength) break;
          startupComplete = true;
          offset += startupLength;
          continue;
        }
        if (frontendBuffer.length - offset < 5) break;
        const type = String.fromCharCode(frontendBuffer[offset]);
        const messageLength = frontendBuffer.readInt32BE(offset + 1);
        const totalLength = 1 + messageLength;
        if (messageLength < 4 || frontendBuffer.length - offset < totalLength) break;
        if (type === "Q" && armed) {
          const sql = frontendBuffer.subarray(offset + 5, offset + totalLength - 1).toString("utf8").trim().replace(/;$/, "").trim();
          if (/^commit$/i.test(sql)) {
            armed = false;
            dropThisCommitResponse = true;
            responseBuffer = Buffer.alloc(0);
            responseParseOffset = 0;
            sawCommitComplete = false;
          }
        }
        offset += totalLength;
      }
      frontendBuffer = frontendBuffer.subarray(offset);
      if (upstream.connecting) queued.push(data);
      else upstream.write(data);
    });

    upstream.on("connect", () => {
      for (const chunk of queued.splice(0)) upstream.write(chunk);
    });

    upstream.on("data", data => {
      if (!dropThisCommitResponse) {
        if (!client.destroyed) client.write(data);
        return;
      }
      responseBuffer = Buffer.concat([responseBuffer, data]);
      while (responseBuffer.length - responseParseOffset >= 5) {
        const type = String.fromCharCode(responseBuffer[responseParseOffset]);
        const messageLength = responseBuffer.readInt32BE(responseParseOffset + 1);
        const totalLength = 1 + messageLength;
        if (messageLength < 4 || responseBuffer.length - responseParseOffset < totalLength) break;
        const payload = responseBuffer.subarray(responseParseOffset + 5, responseParseOffset + totalLength);
        if (type === "E") {
          // COMMIT returned an error instead of success; preserve the server response.
          dropThisCommitResponse = false;
          if (!client.destroyed) client.write(responseBuffer);
          responseBuffer = Buffer.alloc(0);
          responseParseOffset = 0;
          return;
        }
        if (type === "C" && payload.toString("latin1") === "COMMIT\0") sawCommitComplete = true;
        responseParseOffset += totalLength;
        if (type === "Z" && sawCommitComplete) {
          droppedCommitResponses++;
          // PostgreSQL has completed COMMIT and sent ReadyForQuery, but neither reply
          // is delivered to the application, so its transaction outcome is unknown.
          client.destroy();
          upstream.destroy();
          return;
        }
      }
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(proxyPort, "127.0.0.1", resolve);
  });

  // Configure only the disposable synthetic owner account for a real login-endpoint
  // round trip later in this test; never touches a non-local database.
  await pool.query(`
    create table if not exists auth_credentials (
      user_id uuid primary key references users(id) on delete cascade,
      password_hash text not null
    )
  `);
  const ownerEmail = "commit-outcome-owner-" + crypto.randomUUID() + "@example.test";
  const ownerPassword = "CommitOutcome-test-password-2026!";
  const ownerSalt = crypto.randomBytes(16);
  const ownerDerived = Buffer.from(await promisify(crypto.scrypt)(ownerPassword, ownerSalt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024
  }));
  const ownerPasswordHash = `scrypt$16384$8$1$${ownerSalt.toString("base64url")}$${ownerDerived.toString("base64url")}`;
  await pool.query("update users set email=$1 where id=$2 and office_id=$3", [ownerEmail, ids.user, ids.office]);
  await pool.query("insert into auth_credentials(user_id,password_hash) values($2,$1) on conflict (user_id) do update set password_hash=excluded.password_hash", [ownerPasswordHash, ids.user]);
  await pool.query("update auth_sessions set expires_at=now()+interval '1 hour', revoked_at=null where token_hash=$1 and user_id=$2 and office_id=$3",
    [hash(token), ids.user, ids.office]);
  const sessionCheck = await pool.query(
    "select count(*)::int as count from auth_sessions where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null and expires_at>now()",
    [hash(token), ids.user, ids.office]
  );
  assert.equal(sessionCheck.rows[0].count, 1, "test-only owner session must be live");

  const proxyUrl = `postgres://postgres:postgres@127.0.0.1:${proxyPort}/dadban_test?sslmode=disable&note=localhost`;
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(apiPort),
      NODE_ENV: "test",
      DATABASE_URL: proxyUrl,
      CORS_ORIGIN: origin,
      RATE_LIMIT_MODE: "memory"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
  server.stderr.on("data", chunk => { serverOutput += chunk.toString(); });
  await waitForServer(apiPort);

  const makeDocument = async (title, caseId = ids.case) => {
    const result = await pool.query(
      "insert into case_documents(office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,$3,'evidence','normal',$4,$4) returning id",
      [ids.office, caseId, title, ids.user]
    );
    return result.rows[0].id;
  };

  // Case 1: COMMIT result is lost after a metadata update commits.
  const patchId = await makeDocument("Before lost COMMIT update");
  const patchKey = "commit-loss-patch-01";
  armed = true;
  const firstPatch = await request(`/api/case-documents/${patchId}`, {
    method: "PATCH", key: patchKey, body: { title: "Committed despite lost COMMIT response" }
  });
  assert.equal(droppedCommitResponses, 1, "proxy must drop the PostgreSQL COMMIT response for PATCH");
  assert.equal(firstPatch.status, 500, "unknown COMMIT outcome must not be mislabeled as a confirmed rollback");
  assert.deepEqual(firstPatch.body, { error: "database_error" });
  await waitForCompletedKey(patchKey, 200);
  assert.equal((await pool.query("select title from case_documents where id=$1", [patchId])).rows[0].title,
    "Committed despite lost COMMIT response", "the first PATCH must be visible in PostgreSQL after the response is dropped");
  assert.equal(await countAudit(patchId, "update"), 1, "committed PATCH must have exactly one audit row");
  const patchRetry = await request(`/api/case-documents/${patchId}`, {
    method: "PATCH", key: patchKey, body: { title: "Committed despite lost COMMIT response" }
  });
  assert.equal(patchRetry.status, 200, "same-key retry must resolve the unknown PATCH outcome");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey])).rows[0].count, 1, "PATCH must retain one durable idempotency row");
  assert.equal(await countAudit(patchId, "update"), 1, "PATCH retry must not duplicate audit rows");

  // A completed PATCH key is bound to the canonical payload, not merely the resource.
  const patchPayloadConflict = await request(`/api/case-documents/${patchId}`, {
    method: "PATCH", key: patchKey, body: { title: "Conflicting payload must not apply" }
  });
  assert.equal(patchPayloadConflict.status, 409, "same key/resource with a different PATCH payload must conflict");
  assert.deepEqual(patchPayloadConflict.body, { error: "idempotency_key_reused" });
  assert.equal((await pool.query("select title from case_documents where id=$1", [patchId])).rows[0].title,
    "Committed despite lost COMMIT response", "conflicting payload must not overwrite the completed PATCH result");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  )).rows[0].count, 1, "payload conflict must retain exactly one idempotency row");
  assert.equal(await countAudit(patchId, "update"), 1, "payload conflict must not append a second audit row");
  console.log("PASS: completed PATCH key reused with a different payload returns 409; title, one key row, and one audit remain");

  // Case 2: confidentiality change uses the same durable transaction contract.
  const classificationId = await makeDocument("Before lost COMMIT confidentiality");
  const classificationKey = "commit-loss-class-01";
  armed = true;
  const firstClassification = await request(`/api/case-documents/${classificationId}`, {
    method: "PATCH", key: classificationKey, body: { confidentiality: "confidential" }
  });
  assert.equal(droppedCommitResponses, 2, "proxy must drop the PostgreSQL COMMIT response for confidentiality change");
  assert.equal(firstClassification.status, 500);
  await waitForCompletedKey(classificationKey, 200);
  assert.equal((await pool.query("select confidentiality from case_documents where id=$1", [classificationId])).rows[0].confidentiality,
    "confidential", "confidentiality change must have committed despite the missing acknowledgement");
  const classAudit = await pool.query(
    "select metadata from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2 and action='update'",
    [ids.office, classificationId]
  );
  assert.equal(classAudit.rowCount, 1, "confidentiality transition must have exactly one audit event");
  assert.deepEqual(classAudit.rows[0].metadata.confidentiality_change, { from: "normal", to: "confidential" });
  const classRetry = await request(`/api/case-documents/${classificationId}`, {
    method: "PATCH", key: classificationKey, body: { confidentiality: "confidential" }
  });
  assert.equal(classRetry.status, 200);
  assert.equal(await countAudit(classificationId, "update"), 1, "confidentiality replay must not duplicate audit rows");

  // Case 3: a successful soft-delete whose COMMIT acknowledgement is lost must replay 204.
  const deleteId = await makeDocument("Before lost COMMIT delete");
  const deleteKey = "commit-loss-delete-01";
  armed = true;
  const firstDelete = await request(`/api/case-documents/${deleteId}`, {
    method: "DELETE", key: deleteKey
  });
  assert.equal(droppedCommitResponses, 3, "proxy must drop the PostgreSQL COMMIT response for DELETE");
  assert.equal(firstDelete.status, 500, "lost COMMIT acknowledgement must remain an unknown outcome");
  assert.deepEqual(firstDelete.body, { error: "database_error" });
  await waitForCompletedKey(deleteKey, 204);
  assert.ok((await pool.query("select deleted_at from case_documents where id=$1", [deleteId])).rows[0].deleted_at,
    "soft-delete must be visible in PostgreSQL after dropped COMMIT response");
  assert.equal(await countAudit(deleteId, "delete"), 1, "committed DELETE must have exactly one audit row");
  const deleteRetry = await request(`/api/case-documents/${deleteId}`, {
    method: "DELETE", key: deleteKey
  });
  assert.equal(deleteRetry.status, 204, "same-key DELETE retry must replay success, not return 404");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, deleteKey])).rows[0].count, 1, "DELETE must retain one durable idempotency row");
  assert.equal(await countAudit(deleteId, "delete"), 1, "DELETE retry must not duplicate audit rows");

  // Verify that the discarded connection was not reused as healthy by making a fresh
  // request on the same server/pool after all three fault-injected COMMITs.
  const health = await fetch(`http://127.0.0.1:${apiPort}/health/db`);
  assert.equal(health.status, 200, "pool must recover after discarding broken COMMIT connections");

  // Restart the API process while keeping the same disposable PostgreSQL database.
  // Durable key rows, not process memory, must resolve the replay after restart.
  const stoppedServer = server;
  const stoppedServerExit = new Promise(resolve => stoppedServer.once("exit", resolve));
  stoppedServer.kill("SIGKILL");
  await stoppedServerExit;
  server = null;
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(apiPort),
      NODE_ENV: "test",
      DATABASE_URL: proxyUrl,
      CORS_ORIGIN: origin,
      RATE_LIMIT_MODE: "memory"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
  server.stderr.on("data", chunk => { serverOutput += chunk.toString(); });
  await waitForServer(apiPort);

  const restartedReplay = await request(`/api/case-documents/${patchId}`, {
    method: "PATCH", key: patchKey, body: { title: "Committed despite lost COMMIT response" }
  });
  assert.equal(restartedReplay.status, 200, "same-key replay after API restart must return the committed result");
  const restartKeyState = await pool.query(
    "select response_status, created_at from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  );
  assert.equal(restartKeyState.rowCount, 1, "restart must preserve one durable idempotency record");
  assert.equal(restartKeyState.rows[0].response_status, 200);
  assert.equal(await countAudit(patchId, "update"), 1, "restart replay must not duplicate the audit event");
  assert.equal((await pool.query("select title from case_documents where id=$1", [patchId])).rows[0].title,
    "Committed despite lost COMMIT response", "restart replay must not change the committed business result");
  console.log("PASS: API restart replays the durable PostgreSQL idempotency result without a second mutation or audit row");

  // There is deliberately no TTL in migration 006: make the existing key older
  // than one year and verify it remains reserved and replayable.
  await pool.query(
    "update case_document_mutation_idempotency set created_at=now()-interval '400 days' where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  );
  const agedReplay = await request(`/api/case-documents/${patchId}`, {
    method: "PATCH", key: patchKey, body: { title: "Committed despite lost COMMIT response" }
  });
  assert.equal(agedReplay.status, 200, "an old key must remain replayable because the current contract has no expiry");
  const agedState = await pool.query(
    "select created_at, response_status from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  );
  assert.equal(agedState.rowCount, 1);
  assert.equal(agedState.rows[0].response_status, 200);
  assert.ok(agedState.rows[0].created_at < new Date(Date.now() - 399 * 24 * 60 * 60 * 1000),
    "test must confirm the key is genuinely older than 399 days");
  assert.equal(await countAudit(patchId, "update"), 1, "aged replay must not duplicate audit");
  console.log("PASS: 400-day-old idempotency key remains reserved; no TTL expiry is implemented");

  // Safe retention: purge replay data by setting a tombstone marker, never DELETE
  // the unique operation identity. Replay after the marker must be rejected and
  // must not execute a second mutation or append another audit event.
  const purged = await pool.query(
    "update case_document_mutation_idempotency set purged_at=clock_timestamp() where office_id=$1 and user_id=$2 and idempotency_key=$3 and response_status is not null returning purged_at",
    [ids.office, ids.user, patchKey]
  );
  assert.equal(purged.rowCount, 1, "retention must mark the completed key as purged");
  const afterCleanupReplay = await request(`/api/case-documents/${patchId}`, {
    method: "PATCH", key: patchKey, body: { title: "Committed despite lost COMMIT response" }
  });
  assert.equal(afterCleanupReplay.status, 410, "a tombstoned key must never be treated as a new operation");
  assert.deepEqual(afterCleanupReplay.body, { error: "idempotency_result_purged" });
  assert.equal((await pool.query("select title from case_documents where id=$1", [patchId])).rows[0].title,
    "Committed despite lost COMMIT response", "tombstone replay must not mutate the document again");
  const cleanupKeyRows = await pool.query(
    "select response_status, purged_at from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  );
  assert.equal(cleanupKeyRows.rowCount, 1, "operation identity must survive response-data purge");
  assert.equal(cleanupKeyRows.rows[0].response_status, 200);
  assert.ok(cleanupKeyRows.rows[0].purged_at instanceof Date);
  assert.equal(await countAudit(patchId, "update"), 1,
    "tombstone replay must not duplicate the audit event");
  const reopenTombstone = await pool.query(
    "update case_document_mutation_idempotency set purged_at=null where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  ).then(() => null, error => error);
  assert.ok(reopenTombstone, "database trigger must reject clearing purged_at");
  const rewriteIdentity = await pool.query(
    "update case_document_mutation_idempotency set request_fingerprint=repeat('0',64) where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  ).then(() => null, error => error);
  assert.ok(rewriteIdentity, "database trigger must reject rewriting the operation fingerprint");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3 and purged_at is not null",
    [ids.office, ids.user, patchKey]
  )).rows[0].count, 1, "tombstone must remain irreversible after rejected updates");
  console.log("PASS: tombstone cannot be reopened and operation identity cannot be rewritten, even by privileged test connection");
  const forbiddenDelete = await pool.query(
    "delete from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  ).then(() => null, error => error);
  assert.ok(forbiddenDelete, "database trigger must reject physical deletion of an idempotency tombstone");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  )).rows[0].count, 1, "failed physical delete must preserve the tombstone");
  console.log("PASS: PATCH retention tombstone rejects replay, preserves one idempotency identity/audit row, and database trigger blocks physical deletion");

  // Repeat the tombstone contract for DELETE. The business record is soft-deleted,
  // but the key must remain reserved even after replay response data is purged.
  const tombstoneDeleteId = await makeDocument("Before tombstoned DELETE");
  const tombstoneDeleteKey = "tombstone-delete-01";
  const firstTombstoneDelete = await request(`/api/case-documents/${tombstoneDeleteId}`, {
    method: "DELETE", key: tombstoneDeleteKey
  });
  assert.equal(firstTombstoneDelete.status, 204);
  const deleteKeyBeforePurge = await pool.query(
    "select response_status from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, tombstoneDeleteKey]
  );
  assert.equal(deleteKeyBeforePurge.rowCount, 1);
  assert.equal(deleteKeyBeforePurge.rows[0].response_status, 204);
  assert.equal(await countAudit(tombstoneDeleteId, "delete"), 1);
  await pool.query(
    "update case_document_mutation_idempotency set purged_at=clock_timestamp() where office_id=$1 and user_id=$2 and idempotency_key=$3 and response_status=204",
    [ids.office, ids.user, tombstoneDeleteKey]
  );
  const deleteReplayAfterPurge = await request(`/api/case-documents/${tombstoneDeleteId}`, {
    method: "DELETE", key: tombstoneDeleteKey
  });
  assert.equal(deleteReplayAfterPurge.status, 410, "purged DELETE response must not run DELETE again");
  const deleteKeyAfterPurge = await pool.query(
    "select response_status, purged_at from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, tombstoneDeleteKey]
  );
  assert.equal(deleteKeyAfterPurge.rowCount, 1);
  assert.equal(deleteKeyAfterPurge.rows[0].response_status, 204);
  assert.ok(deleteKeyAfterPurge.rows[0].purged_at instanceof Date);
  assert.ok((await pool.query("select deleted_at from case_documents where id=$1", [tombstoneDeleteId])).rows[0].deleted_at);
  assert.equal(await countAudit(tombstoneDeleteId, "delete"), 1, "purged DELETE replay must not duplicate audit");
  console.log("PASS: DELETE tombstone preserves one completed key and one audit event; replay after purge returns 410");

  // Race a replay against retention. SELECT ... FOR UPDATE in the request and
  // UPDATE purged_at in cleanup serialize on the same row. Either the replay
  // wins and returns the original response, or cleanup wins and replay returns
  // 410; neither ordering may execute the mutation or append a second audit.
  const raceId = await makeDocument("Before replay-retention race");
  const raceKey = "tombstone-race-01";
  const raceInitial = await request(`/api/case-documents/${raceId}`, {
    method: "PATCH", key: raceKey, body: { title: "Committed before retention race" }
  });
  assert.equal(raceInitial.status, 200);
  const raceCleanupAndReplay = await Promise.all([
    pool.query(
      "update case_document_mutation_idempotency set purged_at=clock_timestamp() where office_id=$1 and user_id=$2 and idempotency_key=$3 and response_status=200 returning idempotency_key",
      [ids.office, ids.user, raceKey]
    ),
    request(`/api/case-documents/${raceId}`, {
      method: "PATCH", key: raceKey, body: { title: "Committed before retention race" }
    })
  ]);
  assert.equal(raceCleanupAndReplay[0].rowCount, 1, "race cleanup must mark exactly one key");
  assert.ok([200, 410].includes(raceCleanupAndReplay[1].status),
    "serialized replay/cleanup may return original response or 410, never execute as new");
  assert.equal((await pool.query("select title from case_documents where id=$1", [raceId])).rows[0].title,
    "Committed before retention race", "replay/cleanup race must not apply a second mutation");
  const raceKeyState = await pool.query(
    "select count(*)::int as count, min(purged_at) as purged_at from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, raceKey]
  );
  assert.equal(raceKeyState.rows[0].count, 1);
  assert.ok(raceKeyState.rows[0].purged_at instanceof Date);
  assert.equal(await countAudit(raceId, "update"), 1, "replay/cleanup race must preserve exactly one audit row");
  console.log("PASS: replay racing retention serializes on the idempotency row; one mutation/key/audit remains");

  const totals = await pool.query(
    "select (select count(*)::int from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key in ($3,$4,$5)) as idempotency_rows, (select count(*)::int from audit_logs where office_id=$1 and entity_type='case_document' and entity_id in ($6,$7,$8) and action in ('update','delete')) as audit_rows",
    [ids.office, ids.user, patchKey, tombstoneDeleteKey, raceKey, patchId, tombstoneDeleteId, raceId]
  );
  assert.equal(totals.rows[0].idempotency_rows, 3, "direct PostgreSQL count must show one durable identity per PATCH/DELETE/race case");
  assert.equal(totals.rows[0].audit_rows, 3, "direct PostgreSQL count must show one audit event per business mutation");
  console.log(`DB ASSERTIONS: tombstone_cases=3 idempotency_rows=${totals.rows[0].idempotency_rows} audit_rows=${totals.rows[0].audit_rows}`);

  // Case 4: soft-deleting a case must be replayable when COMMIT succeeded but
  // its acknowledgement was lost. Use the same durable key on retry.
  const caseKey = "commit-loss-case-delete-01";
  const missingCaseKey = await request(`/api/cases/${ids.case}`, { method: "DELETE" });
  assert.equal(missingCaseKey.status, 428, "case DELETE without Idempotency-Key must return explicit precondition-required");
  assert.deepEqual(missingCaseKey.body, { error: "idempotency_key_required" });
  assert.equal((await pool.query("select deleted_at from cases where id=$1 and office_id=$2", [ids.case, ids.office])).rows[0].deleted_at, null, "missing case key must not soft-delete");
  assert.equal(await countEntityAudit("case", ids.case, "delete"), 0, "missing case key must not emit audit");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3", [ids.office, ids.user, caseKey])).rows[0].count, 0, "missing case key must not reserve idempotency record");
  armed = true;
  const firstCaseDelete = await request(`/api/cases/${ids.case}`, {
    method: "DELETE", key: caseKey
  });
  assert.equal(droppedCommitResponses, 4, "proxy must drop PostgreSQL COMMIT response for case DELETE");
  assert.equal(firstCaseDelete.status, 500, "case DELETE must report unknown outcome, not confirmed rollback");
  assert.deepEqual(firstCaseDelete.body, { error: "database_error" });
  await waitForCompletedKey(caseKey, 204);
  const caseAfterDelete = await pool.query("select deleted_at from cases where id=$1 and office_id=$2", [ids.case, ids.office]);
  assert.equal(caseAfterDelete.rowCount, 1);
  assert.ok(caseAfterDelete.rows[0].deleted_at, "case soft-delete must be committed despite lost acknowledgement");
  assert.equal(await countEntityAudit("case", ids.case, "delete"), 1, "case DELETE must append exactly one audit row");
  const caseDeleteRetry = await request(`/api/cases/${ids.case}`, { method: "DELETE", key: caseKey });
  assert.equal(caseDeleteRetry.status, 204, "same-key case DELETE retry must replay success, not return 404");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3", [ids.office, ids.user, caseKey])).rows[0].count, 1);
  assert.equal(await countEntityAudit("case", ids.case, "delete"), 1, "case DELETE retry must not duplicate audit rows");

  // Case 5: repeat the lost-acknowledgement proof for the case's client after
  // the case is tombstoned. Both operation kinds share the durable key table but
  // their resource discriminator prevents a cross-resource key collision.
  const clientRef = await pool.query("select client_id from cases where id=$1 and office_id=$2", [ids.case, ids.office]);
  assert.equal(clientRef.rowCount, 1, "test case must retain its client identity");
  const clientId = clientRef.rows[0].client_id;
  const clientKey = "commit-loss-client-delete-01";
  const missingClientKey = await request(`/api/clients/${clientId}`, { method: "DELETE" });
  assert.equal(missingClientKey.status, 428, "client DELETE without Idempotency-Key must return explicit precondition-required");
  assert.deepEqual(missingClientKey.body, { error: "idempotency_key_required" });
  assert.equal((await pool.query("select deleted_at from clients where id=$1 and office_id=$2", [clientId, ids.office])).rows[0].deleted_at, null, "missing client key must not soft-delete");
  assert.equal(await countEntityAudit("client", clientId, "delete"), 0, "missing client key must not emit audit");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3", [ids.office, ids.user, clientKey])).rows[0].count, 0, "missing client key must not reserve idempotency record");
  armed = true;
  const firstClientDelete = await request(`/api/clients/${clientId}`, {
    method: "DELETE", key: clientKey
  });
  assert.equal(droppedCommitResponses, 5, "proxy must drop PostgreSQL COMMIT response for client DELETE");
  assert.equal(firstClientDelete.status, 500, "client DELETE must report unknown outcome, not confirmed rollback");
  assert.deepEqual(firstClientDelete.body, { error: "database_error" });
  await waitForCompletedKey(clientKey, 204);
  const clientAfterDelete = await pool.query("select deleted_at from clients where id=$1 and office_id=$2", [clientId, ids.office]);
  assert.equal(clientAfterDelete.rowCount, 1);
  assert.ok(clientAfterDelete.rows[0].deleted_at, "client soft-delete must be committed despite lost acknowledgement");
  assert.equal(await countEntityAudit("client", clientId, "delete"), 1, "client DELETE must append exactly one audit row");
  const clientDeleteRetry = await request(`/api/clients/${clientId}`, { method: "DELETE", key: clientKey });
  assert.equal(clientDeleteRetry.status, 204, "same-key client DELETE retry must replay success, not return 404");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3", [ids.office, ids.user, clientKey])).rows[0].count, 1);
  assert.equal(await countEntityAudit("client", clientId, "delete"), 1, "client DELETE retry must not duplicate audit rows");

  const deletionTotals = await pool.query(
    "select (select count(*)::int from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key in ($3,$4)) as idempotency_rows, (select count(*)::int from audit_logs where office_id=$1 and ((entity_type='case' and entity_id=$5 and action='delete') or (entity_type='client' and entity_id=$6 and action='delete'))) as audit_rows",
    [ids.office, ids.user, caseKey, clientKey, ids.case, clientId]
  );
  assert.equal(deletionTotals.rows[0].idempotency_rows, 2, "case and client DELETE must each retain one durable idempotency record");
  assert.equal(deletionTotals.rows[0].audit_rows, 2, "case and client DELETE must each retain exactly one audit event");

  const crossResourceKeyReuse = await request(`/api/cases/${ids.case}`, { method: "DELETE", key: clientKey });
  assert.equal(crossResourceKeyReuse.status, 409, "reusing the client DELETE key for case DELETE must conflict");
  assert.deepEqual(crossResourceKeyReuse.body, { error: "idempotency_key_reused" });
  assert.equal(await countEntityAudit("case", ids.case, "delete"), 1, "cross-resource key reuse must not duplicate case audit");
  assert.equal(await countEntityAudit("client", clientId, "delete"), 1, "cross-resource key reuse must not duplicate client audit");
  assert.equal((await pool.query("select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key in ($3,$4)", [ids.office, ids.user, caseKey, clientKey])).rows[0].count, 2, "cross-resource key reuse must not create another idempotency row");
  // Concurrent same-key deletes must serialize on the unique idempotency row.
  // Both callers receive the same durable result, while the mutation and audit occur once.
  const raceClientId = crypto.randomUUID();
  const standaloneClientId = crypto.randomUUID();
  const raceCaseId = crypto.randomUUID();
  const sessionCaseId = crypto.randomUUID();
  const raceNationalIds = [
    "9" + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0"),
    "9" + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0")
  ];
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Concurrent delete parent',$3,$4,$4),($5,$2,'individual','Concurrent standalone client',$6,$4,$4)",
    [raceClientId, ids.office, raceNationalIds[0], ids.user, standaloneClientId, raceNationalIds[1]]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Concurrent delete case',$5,$5),($6,$2,$3,$7,'Session expiry retry case',$5,$5)",
    [raceCaseId, ids.office, raceClientId, "RACE-" + crypto.randomUUID(), ids.user, sessionCaseId, "SESSION-" + crypto.randomUUID()]
  );
  const concurrentKey = "concurrent-delete-" + crypto.randomUUID();
  const concurrentResults = await Promise.all([
    request(`/api/cases/${raceCaseId}`, { method: "DELETE", key: concurrentKey }),
    request(`/api/cases/${raceCaseId}`, { method: "DELETE", key: concurrentKey })
  ]);
  assert.deepEqual(concurrentResults.map(result => result.status).sort(), [204, 204],
    "concurrent same-key case DELETE callers must both observe successful replay");
  await waitForCompletedKey(concurrentKey, 204);
  assert.ok((await pool.query("select deleted_at from cases where id=$1 and office_id=$2", [raceCaseId, ids.office])).rows[0].deleted_at);
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, concurrentKey]
  )).rows[0].count, 1, "concurrent same-key case deletes must reserve one operation identity");
  assert.equal(await countEntityAudit("case", raceCaseId, "delete"), 1,
    "concurrent same-key case deletes must append one audit event");
  console.log("PASS: concurrent same-key case DELETE returns 204 to both callers with one idempotency row and one audit event");

  const concurrentClientKey = "concurrent-client-delete-" + crypto.randomUUID();
  const concurrentClientResults = await Promise.all([
    request(`/api/clients/${standaloneClientId}`, { method: "DELETE", key: concurrentClientKey }),
    request(`/api/clients/${standaloneClientId}`, { method: "DELETE", key: concurrentClientKey })
  ]);
  assert.deepEqual(concurrentClientResults.map(result => result.status).sort(), [204, 204],
    "concurrent same-key client DELETE callers must both observe successful replay");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, concurrentClientKey]
  )).rows[0].count, 1, "concurrent same-key client deletes must reserve one operation identity");
  assert.equal(await countEntityAudit("client", standaloneClientId, "delete"), 1,
    "concurrent same-key client deletes must append one audit event");
  console.log("PASS: concurrent same-key client DELETE returns 204 to both callers with one idempotency row and one audit event");

  // PATCH concurrency is distinct from DELETE concurrency: two identical edits race.
  // Use a dedicated live parent; the primary fixture case was soft-deleted by the
  // earlier case DELETE idempotency scenario.
  const concurrentPatchClientId = crypto.randomUUID();
  const concurrentPatchCaseId = crypto.randomUUID();
  const concurrentPatchNationalId = "7" + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0");
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Concurrent PATCH parent',$3,$4,$4)",
    [concurrentPatchClientId, ids.office, concurrentPatchNationalId, ids.user]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Concurrent PATCH case',$5,$5)",
    [concurrentPatchCaseId, ids.office, concurrentPatchClientId, "PATCH-RACE-" + crypto.randomUUID(), ids.user]
  );
  const concurrentPatchId = await makeDocument("Before concurrent PATCH", concurrentPatchCaseId);
  const concurrentPatchKey = "concurrent-patch-" + crypto.randomUUID();
  const concurrentPatchPayload = { title: "Concurrent PATCH committed once" };
  const concurrentPatchResults = await Promise.all([
    request(`/api/case-documents/${concurrentPatchId}`, { method: "PATCH", key: concurrentPatchKey, body: concurrentPatchPayload }),
    request(`/api/case-documents/${concurrentPatchId}`, { method: "PATCH", key: concurrentPatchKey, body: concurrentPatchPayload })
  ]);
  assert.deepEqual(concurrentPatchResults.map(result => result.status).sort(), [200, 200],
    "concurrent same-key identical PATCH callers must both observe the completed result");
  await waitForCompletedKey(concurrentPatchKey, 200);
  assert.equal((await pool.query("select title from case_documents where id=$1", [concurrentPatchId])).rows[0].title,
    concurrentPatchPayload.title, "concurrent PATCH must leave the requested final title");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, concurrentPatchKey]
  )).rows[0].count, 1, "concurrent PATCH must reserve one idempotency identity");
  assert.equal(await countAudit(concurrentPatchId, "update"), 1, "concurrent PATCH must append exactly one audit row");
  console.log("PASS: concurrent same-key PATCH returns 200 to both callers with one idempotency row and one audit event");

  // Expire the old session, then use the real login endpoint to obtain a different
  // token for the same user/office and replay the completed operation.
  const sessionRetryKey = "session-expiry-delete-" + crypto.randomUUID();
  const sessionRetryFirst = await request(`/api/cases/${sessionCaseId}`, { method: "DELETE", key: sessionRetryKey });
  assert.equal(sessionRetryFirst.status, 204, "case delete should complete before expiry test");
  const originalDeleteAuditCount = await countEntityAudit("case", sessionCaseId, "delete");
  assert.equal(originalDeleteAuditCount, 1, "initial delete must write one audit event");
  await pool.query(
    "update auth_sessions set expires_at=now()-interval '1 minute' where token_hash=$1 and user_id=$2 and office_id=$3",
    [hash(token), ids.user, ids.office]
  );
  const expiredRetry = await request(`/api/cases/${sessionCaseId}`, { method: "DELETE", key: sessionRetryKey });
  assert.equal(expiredRetry.status, 401, "expired session must be rejected before idempotency replay");
  const liveCountBeforeLogin = await pool.query(
    "select count(*)::int as count from auth_sessions where user_id=$1 and office_id=$2 and revoked_at is null and expires_at>now()",
    [ids.user, ids.office]
  );
  assert.equal(liveCountBeforeLogin.rows[0].count, 0, "expired old session must not remain live");
  const freshOwner = await login(ownerEmail, ownerPassword);
  assert.equal(freshOwner.user.id, ids.user);
  assert.equal(freshOwner.user.office_id, ids.office);
  assert.notEqual(freshOwner.token, token, "fresh login must issue a different session token");
  assert.equal((await pool.query(
    "select count(*)::int as count from auth_sessions where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null and expires_at>now()",
    [hash(freshOwner.token), ids.user, ids.office]
  )).rows[0].count, 1, "fresh login must persist a live new session");
  const restoredSessionRetry = await request(`/api/cases/${sessionCaseId}`, {
    method: "DELETE", key: sessionRetryKey, sessionToken: freshOwner.token, csrfToken: freshOwner.csrf
  });
  assert.equal(restoredSessionRetry.status, 204, "fresh login for same user/office must replay the durable result");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3 and response_status=204",
    [ids.office, ids.user, sessionRetryKey]
  )).rows[0].count, 1, "fresh-session replay must reuse the single completed operation record");
  assert.equal(await countEntityAudit("case", sessionCaseId, "delete"), 1, "fresh-session replay must not duplicate delete audit");
  console.log("PASS: expired session returns 401; real fresh login for same user/office replays 204 with one idempotency row and one delete audit");

  // Logout must revoke the just-used session. Only a subsequent real login may replay
  // the completed operation; the revoked cookie must no longer authorize a replay.
  const logoutResponse = await request("/api/auth/logout", {
    method: "POST", sessionToken: freshOwner.token, csrfToken: freshOwner.csrf
  });
  assert.equal(logoutResponse.status, 200, "real logout endpoint must succeed for the fresh session");
  assert.deepEqual(logoutResponse.body, { ok: true });
  assert.equal((await pool.query(
    "select count(*)::int as count from auth_sessions where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is not null",
    [hash(freshOwner.token), ids.user, ids.office]
  )).rows[0].count, 1, "logout must persist revocation of the session used for replay");
  const revokedSessionReplay = await request(`/api/cases/${sessionCaseId}`, {
    method: "DELETE", key: sessionRetryKey, sessionToken: freshOwner.token, csrfToken: freshOwner.csrf
  });
  assert.equal(revokedSessionReplay.status, 401, "logged-out session must not replay even a completed idempotency result");
  const freshAfterLogout = await login(ownerEmail, ownerPassword);
  assert.equal(freshAfterLogout.user.id, ids.user);
  assert.equal(freshAfterLogout.user.office_id, ids.office);
  assert.notEqual(freshAfterLogout.token, freshOwner.token, "login after logout must issue a distinct session");
  assert.equal((await pool.query(
    "select count(*)::int as count from auth_sessions where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null and expires_at>now()",
    [hash(freshAfterLogout.token), ids.user, ids.office]
  )).rows[0].count, 1, "post-logout login must persist a new live session");
  const replayAfterLogoutAndLogin = await request(`/api/cases/${sessionCaseId}`, {
    method: "DELETE", key: sessionRetryKey, sessionToken: freshAfterLogout.token, csrfToken: freshAfterLogout.csrf
  });
  assert.equal(replayAfterLogoutAndLogin.status, 204, "same owner/office must replay completed operation after actual logout and fresh login");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3 and response_status=204",
    [ids.office, ids.user, sessionRetryKey]
  )).rows[0].count, 1, "post-logout replay must reuse exactly one completed idempotency row");
  assert.equal(await countEntityAudit("case", sessionCaseId, "delete"), 1,
    "post-logout replay must preserve exactly one business delete audit row");
  assert.equal((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type='auth_session' and entity_id=$2 and action='logout'",
    [ids.office, (await pool.query("select id from auth_sessions where token_hash=$1", [hash(freshOwner.token)])).rows[0].id]
  )).rows[0].count, 1, "actual logout must append exactly one logout audit row");
  console.log("PASS: real logout revokes session (401 on old cookie); fresh login replays same completed DELETE with one operation/audit row and one logout audit");

  // A different user in the same office must not replay the owner's result.
  const otherUserId = crypto.randomUUID();
  const otherUserEmail = "commit-outcome-other-" + crypto.randomUUID() + "@example.test";
  const otherUserPassword = "CommitOutcome-other-password-2026!";
  const otherSalt = crypto.randomBytes(16);
  const otherDerived = Buffer.from(await promisify(crypto.scrypt)(otherUserPassword, otherSalt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024
  }));
  const otherPasswordHash = `scrypt$16384$8$1$${otherSalt.toString("base64url")}$${otherDerived.toString("base64url")}`;
  await pool.query(
    "insert into users (id,office_id,full_name,email,role) values($1,$2,'Other test user',$3,'assistant')",
    [otherUserId, ids.office, otherUserEmail]
  );
  await pool.query("insert into auth_credentials(user_id,password_hash) values($1,$2)", [otherUserId, otherPasswordHash]);
  const otherUserSession = await login(otherUserEmail, otherUserPassword);
  assert.equal(otherUserSession.user.office_id, ids.office);
  const auditBeforeOtherUserReplay = await countEntityAudit("case", sessionCaseId, "delete");
  const otherUserReplay = await request(`/api/cases/${sessionCaseId}`, {
    method: "DELETE", key: sessionRetryKey,
    sessionToken: otherUserSession.token, csrfToken: otherUserSession.csrf
  });
  assert.equal(otherUserReplay.status, 404, "same-office different user must not learn or replay another user's completed DELETE");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, otherUserId, sessionRetryKey]
  )).rows[0].count, 0, "denied different-user replay must roll back its reservation");
  assert.equal(await countEntityAudit("case", sessionCaseId, "delete"), auditBeforeOtherUserReplay,
    "different-user replay must not add a delete audit event");
  console.log("PASS: different user in same office cannot replay or disclose completed DELETE result");

  // Provision a valid second-office session directly in the disposable PostgreSQL database.
  // This isolates authorization from the public registration endpoint and its rate limit.
  const otherOfficeEmail = "commit-outcome-other-office-" + crypto.randomUUID() + "@example.test";
  const otherOfficeId = crypto.randomUUID();
  const otherOfficeUserId = crypto.randomUUID();
  const otherOfficeToken = crypto.randomBytes(32).toString("base64url");
  const otherOfficeCsrf = crypto.randomBytes(32).toString("base64url");
  await pool.query("insert into offices (id,name) values ($1,$2)", [otherOfficeId, "Commit Outcome Isolated Office"]);
  await pool.query(
    "insert into users (id,office_id,full_name,email,role) values ($1,$2,$3,$4,'owner')",
    [otherOfficeUserId, otherOfficeId, "Other Office Test Owner", otherOfficeEmail]
  );
  await pool.query(
    "insert into auth_sessions (user_id,office_id,token_hash,csrf_hash,expires_at) values ($1,$2,$3,$4,now()+interval '1 hour')",
    [otherOfficeUserId, otherOfficeId, hash(otherOfficeToken), hash(otherOfficeCsrf)]
  );
  const otherOfficeSessionCheck = await pool.query(
    "select count(*)::int as count from auth_sessions where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null and expires_at>now()",
    [hash(otherOfficeToken), otherOfficeUserId, otherOfficeId]
  );
  assert.equal(otherOfficeSessionCheck.rows[0].count, 1, "other-office test session must be valid");
  assert.notEqual(otherOfficeId, ids.office, "test office must be distinct from the operation owner office");
  const auditBeforeOtherOfficeReplay = await countEntityAudit("case", sessionCaseId, "delete");
  const otherOfficeReplay = await request(`/api/cases/${sessionCaseId}`, {
    method: "DELETE", key: sessionRetryKey,
    sessionToken: otherOfficeToken, csrfToken: otherOfficeCsrf
  });
  assert.equal(otherOfficeReplay.status, 404, "different office must not learn or replay the owner's completed DELETE");
  assert.equal((await pool.query(
    "select count(*)::int as count from case_document_mutation_idempotency where office_id=$1 and idempotency_key=$2",
    [otherOfficeId, sessionRetryKey]
  )).rows[0].count, 0, "different-office denied replay must not leave an idempotency reservation");
  assert.equal(await countEntityAudit("case", sessionCaseId, "delete"), auditBeforeOtherOfficeReplay,
    "different-office replay must not add a delete audit event");
  console.log("PASS: different office cannot replay or disclose completed DELETE result; no reservation or duplicate audit");

  // Reusing the completed key for another case is a fingerprint conflict, not a new delete.
  const conflictCaseId = crypto.randomUUID();
  const conflictClientId = crypto.randomUUID();
  const conflictNationalId = "8" + String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0");
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,created_by,updated_by) values($1,$2,'individual','Fingerprint conflict client',$3,$4,$4)",
    [conflictClientId, ids.office, conflictNationalId, ids.user]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,created_by,updated_by) values($1,$2,$3,$4,'Fingerprint conflict case',$5,$5)",
    [conflictCaseId, ids.office, conflictClientId, "CONFLICT-" + crypto.randomUUID(), ids.user]
  );
  const fingerprintConflict = await request(`/api/cases/${conflictCaseId}`, { method: "DELETE", key: sessionRetryKey,
    sessionToken: freshAfterLogout.token, csrfToken: freshAfterLogout.csrf });
  assert.equal(fingerprintConflict.status, 409, "same owner/key with different case resource must be rejected");
  assert.equal((await pool.query("select deleted_at from cases where id=$1 and office_id=$2", [conflictCaseId, ids.office])).rows[0].deleted_at,
    null, "fingerprint conflict must not delete the other case");
  assert.equal(await countEntityAudit("case", conflictCaseId, "delete"), 0, "fingerprint conflict must not audit a second delete");
  assert.equal(await countEntityAudit("case", sessionCaseId, "delete"), 1, "fingerprint conflict must not duplicate original audit");
  console.log("PASS: completed key reused for another case returns 409 without mutation or duplicate audit");


  // Restore the synthetic API session for the separate backup/restore integration test,
  // which independently verifies that a live test session survives database restoration.
  await pool.query(
    "update auth_sessions set expires_at=now()+interval '1 hour', revoked_at=null where token_hash=$1 and user_id=$2 and office_id=$3",
    [hash(token), ids.user, ids.office]
  );
  assert.equal((await pool.query(
    "select count(*)::int as count from auth_sessions where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null and expires_at>now()",
    [hash(token), ids.user, ids.office]
  )).rows[0].count, 1, "restore the synthetic API session after expiry-specific assertions for downstream backup/restore tests");
  console.log("PASS: expiry/re-login assertions completed; synthetic test API session restored for backup/restore coverage");

  console.log("DB ASSERTIONS: unknown_delete_outcomes=2 idempotency_rows=2 audit_rows=2; missing_key=428; cross_resource_key_reuse=409; case/client soft-delete replay is exact-once");

  console.log("PASS: PostgreSQL COMMIT response loss leaves unknown outcome, durable same-key replay, and exactly one mutation/audit row for document PATCH/DELETE plus case/client DELETE");
} catch (error) {
  console.error(error);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  await pool.end();
}
