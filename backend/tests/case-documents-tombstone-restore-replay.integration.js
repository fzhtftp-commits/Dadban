import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (!parsed || !["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/dadban_tombstone_restore_test") {
  throw new Error("Restore replay test may only use the dedicated localhost /dadban_tombstone_restore_test database");
}
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
const apiPort = 18149;
const origin = "http://localhost:5500";
const token = "test-session-office-a-".padEnd(48, "a");
const csrf = "test-csrf-office-a-".padEnd(48, "c");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
let server;
let output = "";
async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${apiPort}/health/db`); if (r.ok) return; } catch {}
    await delay(100);
  }
  throw new Error("Restored-database API did not become healthy");
}
try {
  const identity = await pool.query(
    "select office_id,user_id,entity_id,request_fingerprint from case_document_mutation_idempotency where idempotency_key='commit-loss-patch-01' order by created_at desc limit 1"
  );
  assert.equal(identity.rowCount, 1, "backup must contain the original idempotency key");
  const { office_id, user_id, entity_id } = identity.rows[0];
  const session = await pool.query(
    "select count(*)::int as n from auth_sessions where token_hash=$1 and user_id=$2 and office_id=$3 and revoked_at is null and expires_at>now()",
    [hash(token), user_id, office_id]
  );
  assert.equal(session.rows[0].n, 1, "restored DB must preserve the test API session");
  const before = await pool.query(
    "select (select count(*)::int from case_document_mutation_idempotency) as idem, (select count(*)::int from audit_logs) as audit"
  );
  const row = await pool.query(
    "select purged_at from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key='commit-loss-patch-01'",
    [office_id, user_id]
  );
  assert.ok(row.rows[0].purged_at instanceof Date, "source fixture must be a purged tombstone before backup");
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(apiPort), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin, RATE_LIMIT_MODE: "memory" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", chunk => { output += chunk.toString(); });
  server.stderr.on("data", chunk => { output += chunk.toString(); });
  await waitHealthy();
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/case-documents/${entity_id}`, {
    method: "PATCH",
    headers: { origin, cookie: `dadban_session=${token}; dadban_csrf=${csrf}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": "commit-loss-patch-01" },
    body: JSON.stringify({ title: "Committed despite lost COMMIT response" }),
    signal: AbortSignal.timeout(10000)
  });
  assert.equal(response.status, 410, "same-key API replay after DB restore and service start must reject the purged tombstone");
  assert.deepEqual(await response.json(), { error: "idempotency_result_purged" });
  const after = await pool.query(
    "select (select count(*)::int from case_document_mutation_idempotency) as idem, (select count(*)::int from audit_logs) as audit"
  );
  assert.deepEqual(after.rows[0], before.rows[0], "replay after restore must not append idempotency/audit rows");
  const key = await pool.query(
    "select count(*)::int as n from case_document_mutation_idempotency where office_id=$1 and user_id=$2 and idempotency_key='commit-loss-patch-01' and purged_at is not null",
    [office_id, user_id]
  );
  const audit = await pool.query(
    "select count(*)::int as n from audit_logs where office_id=$1 and entity_type='case_document' and entity_id=$2 and action='update'",
    [office_id, entity_id]
  );
  assert.equal(key.rows[0].n, 1);
  assert.equal(audit.rows[0].n, 1);
  console.log(`RESTORE REPLAY DB ASSERTIONS: idempotency_rows=${after.rows[0].idem} audit_rows=${after.rows[0].audit} key_tombstones=${key.rows[0].n} entity_audit_rows=${audit.rows[0].n}`);
  console.log("PASS: restarted API against restored PostgreSQL replays the same key as 410 without a new mutation, idempotency row, or audit event");
} catch (error) {
  console.error(error);
  if (output) console.error(output);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise(resolve => server.once("exit", resolve));
  }
  await pool.end();
}
