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
  action: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa05",
  targetClient: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa06"
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

async function request(path, method, body, options = {}) {
  const response = await fetch(`http://${options.host ?? "127.0.0.1"}:${port}${path}`, {
    method,
    headers: {
      origin,
      cookie: `dadban_session=${token}; dadban_csrf=${csrf}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
      "user-agent": options.userAgent ?? "dadban-audit-mutation-test"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: response.status === 204 ? null : await response.json() };
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

async function expectAuditFailure({ label, method, path, body, table, entityType, action, auditEntityId, checkUnchanged }) {
  const rowsBefore = await countRows(table);
  const auditBefore = await countAudit(entityType, action);
  const entityAuditBefore = auditEntityId === undefined ? null : Number((await pool.query(
    "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action=$4",
    [ids.office, entityType, auditEntityId, action]
  )).rows[0].count);
  const response = await request(path, method, body);
  assert.equal(response.status, 500, label + ": audit INSERT failure must return 500; got " + response.status);
  assert.deepEqual(response.body, { error: "database_error" }, label + ": response must be sanitized");
  assert.equal(await countAudit(entityType, action), auditBefore, label + ": failed operation must not leave an audit row");
  if (auditEntityId !== undefined) {
    const entityAuditAfter = Number((await pool.query(
      "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3 and action=$4",
      [ids.office, entityType, auditEntityId, action]
    )).rows[0].count);
    assert.equal(entityAuditAfter, entityAuditBefore, label + ": exact entity audit row count must remain unchanged");
  }
  if (method === "POST") {
    assert.equal(await countRows(table), rowsBefore, label + ": failed create must leave no business row");
  } else {
    assert.equal(await countRows(table), rowsBefore, label + ": failed mutation must not add or remove business rows");
    await checkUnchanged();
  }
  console.log("PASS: " + label + " rolls back when audit INSERT fails");
}

try {
  // This script initializes only its explicitly named, disposable CI database.
  await pool.query(await readFile(new URL("../../database/schema.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../database/migrations/20261010_office_isolation_constraints.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../database/migrations/20261014_case_actions.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../migrations/008_security_definer_document_actor_lock.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../migrations/009_case_reassignment_parent_locks.sql", import.meta.url), "utf8"));

  await pool.query(
    "insert into offices(id,name) values ($1,'Audit Mutation Test Office')",
    [ids.office]
  );
  await pool.query(
    "insert into users(id,office_id,full_name,email,role) values ($1,$2,'Audit Mutation Test Owner','audit-mutation-owner@example.test','owner')",
    [ids.user, ids.office]
  );

  const passwordSalt = Buffer.from("dadban-audit-test-salt");
  const passwordDigest = crypto.scryptSync("TestPassword!234", passwordSalt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024
  });
  const passwordHash = `scrypt$16384$8$1$${passwordSalt.toString("base64url")}$${passwordDigest.toString("base64url")}`;
  await pool.query(
    "insert into auth_credentials(user_id,password_hash) values ($1,$2)",
    [ids.user, passwordHash]
  );
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,status,created_by,updated_by) values ($1,$2,'individual','Original Audit Test Client','1234567890','active',$3,$3)",
    [ids.client, ids.office, ids.user]
  );
  await pool.query(
    "insert into clients(id,office_id,client_type,full_name,national_id,status,created_by,updated_by) values ($1,$2,'individual','Target Audit Test Client','1234567891','active',$3,$3)",
    [ids.targetClient, ids.office, ids.user]
  );
  await pool.query(
    "insert into cases(id,office_id,client_id,case_number,title,status,priority,next_hearing_at,created_by,updated_by) values ($1,$2,$3,'AUDIT-ROLLBACK-001','Original Audit Test Case','active','normal',now()+interval '10 days',$4,$4)",
    [ids.case, ids.office, ids.client, ids.user]
  );
  await pool.query(
    "insert into hearings(id,office_id,case_id,hearing_at,hearing_type,status,reminder_minutes,notes,created_by,updated_by) values ($1,$2,$3,(select next_hearing_at from cases where id=$3),'hearing','scheduled',1440,'Original hearing notes',$4,$4)",
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
      if (new.entity_type in ('client','case','hearing','case_action')
          and new.action in ('create','update','delete'))
         or (new.entity_type = 'user' and new.action in ('register','login'))
         or (new.entity_type = 'auth_session' and new.action = 'logout') then
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
      label: "case reassignment", method: "PATCH", path: `/api/cases/${ids.case}`,
      body: { client_id: ids.targetClient, title: "Must Not Persist Case Reassignment" }, table: "cases", entityType: "case", action: "update",
      checkUnchanged: async () => {
        const current = (await pool.query("select title, client_id from cases where id=$1", [ids.case])).rows[0];
        assert.equal(current.title, "Original Audit Test Case");
        assert.equal(current.client_id, ids.client, "audit failure must roll back the client_id relationship");
      }
    },
    {
      label: "case delete", method: "DELETE", path: `/api/cases/${ids.case}`,
      table: "cases", entityType: "case", action: "delete", auditEntityId: ids.case,
      checkUnchanged: async () => {
        const currentCase = (await pool.query(
          "select deleted_at,next_hearing_at from cases where id=$1", [ids.case]
        )).rows[0];
        const hearing = (await pool.query(
          "select case_id,hearing_at,deleted_at from hearings where id=$1", [ids.hearing]
        )).rows[0];
        const action = (await pool.query(
          "select case_id,title,deleted_at from case_actions where id=$1", [ids.action]
        )).rows[0];
        assert.equal(currentCase.deleted_at, null, "audit failure must roll back case deleted_at");
        assert.equal(currentCase.next_hearing_at.getTime(), hearing.hearing_at.getTime(),
          "audit failure must preserve next_hearing_at");
        assert.equal(hearing.case_id, ids.case, "audit failure must preserve dependent hearing case_id");
        assert.equal(hearing.deleted_at, null, "audit failure must preserve dependent hearing deleted_at");
        assert.equal(action.case_id, ids.case, "audit failure must preserve dependent action case_id");
        assert.equal(action.title, "Original action title", "audit failure must preserve dependent action data");
        assert.equal(action.deleted_at, null, "audit failure must preserve dependent action deleted_at");
        for (const [entityType, entityId] of [["hearing", ids.hearing], ["case_action", ids.action]]) {
          const childAuditCount = Number((await pool.query(
            "select count(*)::int as count from audit_logs where office_id=$1 and entity_type=$2 and entity_id=$3",
            [ids.office, entityType, entityId]
          )).rows[0].count);
          assert.equal(childAuditCount, 0, "failed case delete must not emit dependent " + entityType + " audit rows");
        }
      }
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
      table: "hearings", entityType: "hearing", action: "delete", auditEntityId: ids.hearing,
      checkUnchanged: async () => {
        const hearing = (await pool.query("select deleted_at,hearing_at from hearings where id=$1", [ids.hearing])).rows[0];
        const parent = (await pool.query("select next_hearing_at from cases where id=$1", [ids.case])).rows[0];
        assert.equal(hearing.deleted_at, null, "audit failure must roll back hearing deleted_at");
        assert.equal(parent.next_hearing_at.getTime(), hearing.hearing_at.getTime(),
          "audit failure must roll back next_hearing_at recalculation for hearing DELETE");
      }
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
      table: "case_actions", entityType: "case_action", action: "delete", auditEntityId: ids.action,
      checkUnchanged: async () => {
        const action = (await pool.query("select deleted_at from case_actions where id=$1", [ids.action])).rows[0];
        const parent = (await pool.query("select next_hearing_at from cases where id=$1", [ids.case])).rows[0];
        const hearing = (await pool.query("select hearing_at from hearings where id=$1", [ids.hearing])).rows[0];
        assert.equal(action.deleted_at, null, "audit failure must roll back case-action deleted_at");
        assert.equal(parent.next_hearing_at.getTime(), hearing.hearing_at.getTime(),
          "case-action DELETE audit failure must preserve unrelated next_hearing_at");
      }
    }
  ];

  for (const item of cases) await expectAuditFailure(item);

  const registerBefore = await pool.query("select (select count(*) from offices)::int as offices, (select count(*) from users)::int as users, (select count(*) from auth_credentials)::int as credentials, (select count(*) from auth_sessions)::int as sessions");
  const registerAuditBefore = await countAudit("user", "register");
  const failedRegister = await request("/api/auth/register", "POST", {
    full_name: "Must Roll Back Registered User",
    email: "register-audit-failure@example.test",
    password: "StrongPassword!234",
    office_name: "Must Roll Back Registration Office"
  });
  assert.equal(failedRegister.status, 500, "registration must fail when its audit insert fails");
  assert.deepEqual(failedRegister.body, { error: "database_error" }, "registration audit failure must be sanitized");
  const registerAfter = await pool.query("select (select count(*) from offices)::int as offices, (select count(*) from users)::int as users, (select count(*) from auth_credentials)::int as credentials, (select count(*) from auth_sessions)::int as sessions");
  assert.deepEqual(registerAfter.rows[0], registerBefore.rows[0], "registration failure must roll back office, user, credential, and session rows");
  assert.equal(await countAudit("user", "register"), registerAuditBefore, "failed registration must not leave an audit row");
  console.log("PASS: registration rolls back office/user/credentials/session when audit INSERT fails");

  const loginSessionsBefore = await pool.query("select count(*)::int as count from auth_sessions");
  const loginAuditBefore = await countAudit("user", "login");
  const failedLogin = await request("/api/auth/login", "POST", {
    email: "audit-mutation-owner@example.test",
    password: "TestPassword!234"
  });
  assert.equal(failedLogin.status, 500, "login must fail when its audit insert fails");
  assert.deepEqual(failedLogin.body, { error: "authentication_error" }, "login audit failure must remain generic");
  assert.equal((await pool.query("select count(*)::int as count from auth_sessions")).rows[0].count,
    loginSessionsBefore.rows[0].count, "login failure must roll back the newly created session");
  assert.equal(await countAudit("user", "login"), loginAuditBefore, "failed login must not leave an audit row");
  console.log("PASS: login rolls back the new session when audit INSERT fails");

  // Invalid credentials are logged after the login transaction rolls back.
  // The event intentionally carries no account, office, email, password, or token identifier.
  for (const [label, credentials] of [
    ["known account with wrong password", { email: "audit-mutation-owner@example.test", password: "WrongPassword!234" }],
    ["unknown account", { email: "unknown-audit-login@example.test", password: "WrongPassword!234" }]
  ]) {
    const failedAttemptsBefore = Number((await pool.query(
      "select count(*)::int as count from audit_logs where action='login_failed' and entity_type='authentication'"
    )).rows[0].count);
    const response = await request("/api/auth/login", "POST", credentials);
    assert.equal(response.status, 401, `${label}: invalid credentials must remain a generic 401`);
    assert.deepEqual(response.body, { error: "invalid_credentials" });
    const events = await pool.query(
      "select office_id, user_id, entity_id, metadata, ip_address, user_agent from audit_logs where action='login_failed' and entity_type='authentication' order by created_at desc limit 1"
    );
    assert.equal(Number((await pool.query(
      "select count(*)::int as count from audit_logs where action='login_failed' and entity_type='authentication'"
    )).rows[0].count), failedAttemptsBefore + 1, `${label}: failed attempt must create one audit event`);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].office_id, null);
    assert.equal(events.rows[0].user_id, null);
    assert.equal(events.rows[0].entity_id, null);
    assert.deepEqual(events.rows[0].metadata, { reason: "invalid_credentials" });
    assert.equal(events.rows[0].user_agent, "dadban-audit-mutation-test");
    console.log(`PASS: ${label} is audited without account identifiers or credentials`);
  }



  // A failure in the independent audit write must not change the public 401 result.
  await pool.query(`
    create function reject_failed_login_audit() returns trigger language plpgsql as $failed_login_audit$
    begin
      if new.action = 'login_failed' and new.entity_type = 'authentication' then
        raise exception 'forced failed-login audit INSERT failure in disposable integration test';
      end if;
      return new;
    end;
    $failed_login_audit$;
    create trigger reject_failed_login_audit_trigger
      before insert on audit_logs for each row execute function reject_failed_login_audit();
  `);
  const failedAttemptsBeforeAuditOutage = Number((await pool.query(
    "select count(*)::int as count from audit_logs where action='login_failed' and entity_type='authentication'"
  )).rows[0].count);
  const auditUnavailableLogin = await request("/api/auth/login", "POST", {
    email: "audit-mutation-owner@example.test",
    password: "WrongPassword!234"
  });
  assert.equal(auditUnavailableLogin.status, 401, "failed-login audit outage must not turn invalid credentials into 500");
  assert.deepEqual(auditUnavailableLogin.body, { error: "invalid_credentials" });
  assert.equal(Number((await pool.query(
    "select count(*)::int as count from audit_logs where action='login_failed' and entity_type='authentication'"
  )).rows[0].count), failedAttemptsBeforeAuditOutage, "failed audit insert must not leave a partial event");
  await pool.query("drop trigger reject_failed_login_audit_trigger on audit_logs; drop function reject_failed_login_audit()");
  console.log("PASS: failed-login audit write failure preserves generic 401 response");

  // Audit request metadata is bounded before storage.
  const longUserAgent = "UA".repeat(400);
  const longUaResponse = await request("/api/auth/login", "POST", {
    email: "unknown-long-ua@example.test",
    password: "WrongPassword!234"
  }, { userAgent: longUserAgent });
  assert.equal(longUaResponse.status, 401);
  const boundedUa = await pool.query(
    "select user_agent from audit_logs where action='login_failed' and entity_type='authentication' order by created_at desc limit 1"
  );
  assert.equal(boundedUa.rows[0].user_agent.length, 512, "stored User-Agent must be capped at 512 characters");
  assert.equal(boundedUa.rows[0].user_agent, longUserAgent.slice(0, 512));
  console.log("PASS: audit User-Agent is capped at 512 characters");

  // Login throttling shares a process-local IP bucket with earlier auth scenarios in this integration run.
  let observedRateLimit = false;
  for (let i = 0; i < 11; i++) {
    const limitedWindowResponse = await request("/api/auth/login", "POST", {
      email: `unknown-rate-test-${i}@example.test`,
      password: "WrongPassword!234"
    });
    if (limitedWindowResponse.status === 429) {
      assert.equal(limitedWindowResponse.body.error, "rate_limit_exceeded");
      assert.ok(Number(limitedWindowResponse.headers["retry-after"] ?? 0) >= 1,
        "rate-limited response must include a positive Retry-After header");
      observedRateLimit = true;
      break;
    }
    assert.equal(limitedWindowResponse.status, 401,
      "requests before the rate limit is reached must keep generic invalid-credential responses");
  }
  assert.equal(observedRateLimit, true, "login attempts must eventually be rate limited");
  console.log("PASS: login rate limit returns sanitized 429 with Retry-After after the process/IP budget is exhausted");

  const logoutAuditBefore = await countAudit("auth_session", "logout");
  const failedLogout = await request("/api/auth/logout", "POST");
  assert.equal(failedLogout.status, 500, "logout must fail when its audit insert fails");
  assert.deepEqual(failedLogout.body, { error: "database_error" }, "logout audit failure must be sanitized");
  assert.equal((await pool.query("select revoked_at from auth_sessions where token_hash=$1", [hash(token)] )).rows[0].revoked_at,
    null, "logout failure must roll back session revocation");
  assert.equal(await countAudit("auth_session", "logout"), logoutAuditBefore, "failed logout must not leave an audit row");
  console.log("PASS: logout rolls back session revocation when audit INSERT fails");

  assert.equal(serverOutput.includes("audit-mutation-test-session-token"), false, "server output must not expose the session token");
  assert.equal(serverOutput.includes("audit-mutation-test-csrf-token"), false, "server output must not expose the CSRF token");
  assert.equal(serverOutput.includes("Must Not Persist"), false, "server output must not echo mutation payloads");
  console.log("PASS: all 15 business and authentication mutation rollback scenarios");
} catch (error) {
  console.error(error);
  if (server) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  await pool.end();
}
