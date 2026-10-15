import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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

async function request(path, { method, body, key, port = apiPort }) {
  const headers = {
    origin,
    cookie: `dadban_session=${token}; dadban_csrf=${csrf}`,
    "x-csrf-token": csrf
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

  const makeDocument = async title => {
    const result = await pool.query(
      "insert into case_documents(office_id,case_id,title,document_type,confidentiality,created_by,updated_by) values($1,$2,$3,'evidence','normal',$4,$4) returning id",
      [ids.office, ids.case, title, ids.user]
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

  // Security probe for a future cleanup/migration: deleting the idempotency row
  // removes the only durable key reservation. Reusing the same key then executes
  // the PATCH again and appends another audit row. This is a documented FINDING,
  // not an approved cleanup policy; do not add a cleanup job until a durable
  // tombstone/operation-identity design preserves duplicate protection.
  const removedKey = await pool.query(
    "delete from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3 returning idempotency_key",
    [ids.office, ids.user, patchKey]
  );
  assert.equal(removedKey.rowCount, 1, "cleanup simulation must remove only the selected test key");
  const afterCleanupReplay = await request(`/api/case-documents/${patchId}`, {
    method: "PATCH", key: patchKey, body: { title: "Re-executed after idempotency cleanup" }
  });
  assert.equal(afterCleanupReplay.status, 200, "after deletion, the current implementation treats the old key as new");
  assert.equal((await pool.query("select title from case_documents where id=$1", [patchId])).rows[0].title,
    "Re-executed after idempotency cleanup", "cleanup probe must directly confirm the second mutation");
  const cleanupKeyRows = await pool.query(
    "select response_status from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key=$3",
    [ids.office, ids.user, patchKey]
  );
  assert.equal(cleanupKeyRows.rowCount, 1);
  assert.equal(cleanupKeyRows.rows[0].response_status, 200);
  assert.equal(await countAudit(patchId, "update"), 2,
    "deleting the idempotency row permits a second mutation and a second audit event");
  console.log("FINDING: deleting an idempotency row reopens the key and permits a second mutation/audit; cleanup requires durable tombstones or equivalent protection");

  console.log("PASS: PostgreSQL COMMIT response loss leaves unknown outcome, durable same-key replay, and exactly one mutation/audit row for PATCH, confidentiality change, and DELETE");
} catch (error) {
  console.error(error);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  await pool.end();
}
