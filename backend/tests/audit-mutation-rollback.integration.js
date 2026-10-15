import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
if (!parsed || !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.pathname !== "/dadban_audit_mutations_test") {
  throw new Error("Audit mutation integration test may only use disposable localhost /dadban_audit_mutations_test");
}
const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 });
const port = Number(process.env.DADBAN_AUDIT_TEST_PORT || 18241);
const origin = "http://localhost:5500";
const token = "audit-mutation-test-session-token".padEnd(48, "x");
const csrf = "audit-mutation-test-csrf-token".padEnd(48, "y");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const ids = {
  office: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  client: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
  case: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03",
  hearing: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa04",
  action: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05"
};
let server;
let serverOutput = "";

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error("Dadban API did not become healthy in time");
}

async function request(path, method, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      origin,
      cookie: `dadban_session=${token}; dadban_csrf=${csrf}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
      "user-agent": "dadban-audit-mutation-test"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function countRows(table) {
  const allowed = new Set(["clients", "cases", "hearings", "case_actions"]);
  assert.ok(allowed.has(table), "countRows table must be a fixed test table name");
  return Number((await pool.query(`select count(*)::int as count from ${table}`)).rows[0].count);
}

async function countAudit(entityType, action) {
  return Number((await pool.query(
    "select count(*)::int as count from audit_logs where entity_type=$1 and action=$2",
    [entityType, action]
  )).rows[0].count);
}

async function expectAuditFailure({ label, method, path, body, table, entityType, action, checkUnchanged }) {
  const rowsBefore = await countRows(table);
  const auditBefore = await countAudit(entityType, action);
  const response = await request(path, method, body);
  assert.equal(response.status, 500, `${label}: audit INSERT failure must return 500; got ${response.status}`);
  assert.deepEqual(response.body, { error: "database_error" }, `${label}: response must be sanitized`);
  assert.equal(await countAudit(entityType, action), auditBefore, `${label}: failed operation must not leave an audit row`);
  if (method === "POST") {
    assert.equal(await countRows(table), rowsBefore, `${label}: failed create must leave no business row`);
  } else {
    assert.equal(await countRows(table), rowsBefore, `${label}: failed mutation must not add or remove business rows`);
    await checkUnchanged();
  }
  console.log(`PASS: ${label} rolls back when audit INSERT fails`);
}

try {
  // This script initializes only its explicitly named, disposable CI database.
  await pool.query(await readFile(new URL("../../database/schema.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../database/migrations/20261010_office_isolation_constraints.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../database/migrations/20261014_case_actions.sql", import.meta.url), "utf8"));

  await pool.query(
    "insert into offices(id,name) values ($1,'Audit Mutation Test Office')",
    [ids.office]
  );
  await pool.query(
    "insert into users(id,office_id,full_name,email,role) values ($1,$2,'Audit Mutation Test Owner','audit-mutation-owner@example.test','owner')",
    [ids.user, ids.office]
  );
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,status,created_by,updated_by) values ($1,$2,'individual','Original Audit Test Client','1234567890','active',$3,$3)",
    [ids.client, ids.office, ids.user]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,status,priority,created_by,updated_by) values ($1,$2,$3,'AUDIT-ROLLBACK-001','Original Audit Test Case','active','normal',$4,$4)",
    [ids.case, ids.office, ids.client, ids.user]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,reminder_minutes,notes,created_by,updated_by) values ($1,$2,$3,now()+interval '10 days','hearing','scheduled',1440,'Original hearing notes',$4,$4)",
    [ids.hearing, ids.office, ids.case, ids.user]
  );
  await pool.query(
    "insert into case_actions(id,office_id,case_id,title,status,priority,created_by,updated_by) values ($1,$2,$3,'Original action title','todo','normal',$4,$4)",
    [ids.action, ids.office, ids.case, ids.user]
  );
  await pool.query(
    "insert into auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) values ($1,$2,$3,$4,now()+interval '1 hour')",
    [ids.user, ids.office, hash(token), hash(csrf)]
  );

  // Reject every business mutation's audit row, so each HTTP request must roll back.
  await pool.query(`
    create function reject_business_mutation_audit() returns trigger language plpgsql as $$
    begin
      if new.entity_type in ('client','case','hearing','case_action')
         and new.action in ('create','update','delete') then
        raise exception 'forced audit INSERT failure in disposable integration test';
      end if;
      return new;
    end;
    $$;
    create trigger reject_business_mutation_audit_trigger
      before insert on audit_logs for each row execute function reject_business_mutation_audit();
  `);

  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: databaseUrl, CORS_ORIGIN: origin },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
  server.stderr.on("data", chunk => { serverOutput += chunk.toString(); });
  await waitForServer();

  const cases = [
    {
      label: "client create", method: "POST", path: "/api/clients",
      body: { client_type: "individual", full_name: "Must Roll Back Client", national_id: "1234509876" },
      table: "clients", entityType: "client", action: "create"
    },
    {
      label: "client update", method: "PATCH", path: `/api/clients/${ids.client}`,
      body: { full_name: "Must Not Persist Client Update" }, table: "clients", entityType: "client", action: "update",
      checkUnchanged: async () => assert.equal((await pool.query("select full_name from clients where id=$1", [ids.client])).rows[0].full_name, "Original Audit Test Client")
    },
    {
      label: "client delete", method: "DELETE", path: `/api/clients/${ids.client}`,
      table: "clients", entityType: "client", action: "delete",
      checkUnchanged: async () => assert.equal((await pool.query("select deleted_at from clients where id=$1", [ids.client])).rows[0].deleted_at, null)
    },
    {
      label: "case create", method: "POST", path: "/api/cases",
      body: { client_id: ids.client, case_number: "AUDIT-ROLLBACK-CREATE", title: "Must Roll Back Case" },
      table: "cases", entityType: "case", action: "create"
    },
    {
      label: "case update", method: "PATCH", path: `/api/cases/${ids.case}`,
      body: { title: "Must Not Persist Case Update" }, table: "cases", entityType: "case", action: "update",
      checkUnchanged: async () => assert.equal((await pool.query("select title from cases where id=$1", [ids.case])).rows[0].title, "Original Audit Test Case")
    },
    {
      label: "case delete", method: "DELETE", path: `/api/cases/${ids.case}`,
      table: "cases", entityType: "case", action: "delete",
      checkUnchanged: async () => assert.equal((await pool.query("select deleted_at from cases where id=$1", [ids.case])).rows[0].deleted_at, null)
    },
    {
      label: "hearing create", method: "POST", path: "/api/hearings",
      body: { case_id: ids.case, hearing_at: "2035-01-01T10:00:00.000Z", hearing_type: "hearing" },
      table: "hearings", entityType: "hearing", action: "create"
    },
    {
      label: "hearing update", method: "PATCH", path: `/api/hearings/${ids.hearing}`,
      body: { notes: "Must Not Persist Hearing Update" }, table: "hearings", entityType: "hearing", action: "update",
      checkUnchanged: async () => assert.equal((await pool.query("select notes from hearings where id=$1", [ids.hearing])).rows[0].notes, "Original hearing notes")
    },
    {
      label: "hearing delete", method: "DELETE", path: `/api/hearings/${ids.hearing}`,
      table: "hearings", entityType: "hearing", action: "delete",
      checkUnchanged: async () => assert.equal((await pool.query("select deleted_at from hearings where id=$1", [ids.hearing])).rows[0].deleted_at, null)
    },
    {
      label: "case action create", method: "POST", path: "/api/actions",
      body: { case_id: ids.case, title: "Must Roll Back Action" },
      table: "case_actions", entityType: "case_action", action: "create"
    },
    {
      label: "case action update", method: "PATCH", path: `/api/actions/${ids.action}`,
      body: { title: "Must Not Persist Action Update" }, table: "case_actions", entityType: "case_action", action: "update",
      checkUnchanged: async () => assert.equal((await pool.query("select title from case_actions where id=$1", [ids.action])).rows[0].title, "Original action title")
    },
    {
      label: "case action delete", method: "DELETE", path: `/api/actions/${ids.action}`,
      table: "case_actions", entityType: "case_action", action: "delete",
      checkUnchanged: async () => assert.equal((await pool.query("select deleted_at from case_actions where id=$1", [ids.action])).rows[0].deleted_at, null)
    }
  ];

  for (const item of cases) await expectAuditFailure(item);
  assert.equal(serverOutput.includes("audit-mutation-test-session-token"), false, "server output must not expose the session token");
  assert.equal(serverOutput.includes("audit-mutation-test-csrf-token"), false, "server output must not expose the CSRF token");
  assert.equal(serverOutput.includes("Must Not Persist"), false, "server output must not echo mutation payloads");
  console.log("PASS: all 12 client/case/hearing/case-action mutation rollback scenarios");
} catch (error) {
  console.error(error);
  if (server) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  await pool.end();
}
