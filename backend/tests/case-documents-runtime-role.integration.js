import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { readFile } from "node:fs/promises";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const apiDatabaseUrl = process.env.API_DATABASE_URL;
const adminParsed = databaseUrl ? new URL(databaseUrl) : null;
const apiParsed = apiDatabaseUrl ? new URL(apiDatabaseUrl) : null;
if (!adminParsed || !apiParsed ||
    !["localhost", "127.0.0.1"].includes(adminParsed.hostname) ||
    !["localhost", "127.0.0.1"].includes(apiParsed.hostname) ||
    adminParsed.pathname !== "/dadban_runtime_role_test" ||
    apiParsed.pathname !== "/dadban_runtime_role_test" ||
    apiParsed.username !== "dadban_document_runtime_ci") {
  throw new Error("Runtime-role API test may only use the dedicated localhost /dadban_runtime_role_test database and runtime login");
}

const port = Number(process.env.DADBAN_RUNTIME_ROLE_PORT || 18161);
const origin = "http://localhost:5500";
const officeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
const caseId = "cccccccc-cccc-4ccc-8ccc-cccccccccc02";
const token = "runtime-role-session-".padEnd(48, "r");
const csrf = "runtime-role-csrf-".padEnd(48, "s");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 });
const runtimePool = new Pool({ connectionString: apiDatabaseUrl, ssl: false, max: 2 });
let server;
let output = "";

async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/db`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Least-privilege runtime API did not become healthy");
}
async function request(path, { method = "GET", body, key } = {}) {
  const headers = {
    origin,
    cookie: `dadban_session=${token}; dadban_csrf=${csrf}`,
    "x-csrf-token": csrf
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
async function denied(query, label) {
  const error = await runtimePool.query(query).then(() => null, e => e);
  assert.ok(error, `runtime role unexpectedly succeeded: ${label}`);
  console.log(`PASS: runtime denied ${label}`);
}

try {
  await pool.query(`
    DROP FUNCTION IF EXISTS public.lock_live_document_actor(uuid,uuid,uuid) CASCADE;
    DROP FUNCTION IF EXISTS public.lock_live_client_parent(uuid,uuid) CASCADE;
    DROP FUNCTION IF EXISTS public.lock_live_case_client(uuid,uuid) CASCADE;
    DROP FUNCTION IF EXISTS public.lock_live_case_parents(uuid,uuid[]) CASCADE;
    DROP FUNCTION IF EXISTS public.prevent_case_document_idempotency_delete() CASCADE;
    DROP FUNCTION IF EXISTS public.prevent_case_document_idempotency_reopen() CASCADE;
    DROP TABLE IF EXISTS public.api_mutation_idempotency CASCADE;
    DROP TABLE IF EXISTS public.case_document_mutation_idempotency CASCADE;
    DROP TABLE IF EXISTS public.case_documents CASCADE;
    DROP TABLE IF EXISTS public.audit_logs CASCADE;
    DROP TABLE IF EXISTS public.auth_sessions CASCADE;
    DROP TABLE IF EXISTS public.cases CASCADE;
    DROP TABLE IF EXISTS public.clients CASCADE;
    DROP TABLE IF EXISTS public.users CASCADE;
    DROP TABLE IF EXISTS public.offices CASCADE;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE public.offices (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.users (
      id uuid PRIMARY KEY, office_id uuid NOT NULL REFERENCES public.offices(id),
      full_name text NOT NULL, email text NOT NULL, role text NOT NULL DEFAULT 'owner',
      is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz,
      UNIQUE (id, office_id)
    );
    CREATE TABLE public.clients (
      id uuid PRIMARY KEY, office_id uuid NOT NULL REFERENCES public.offices(id),
      full_name text NOT NULL, deleted_at timestamptz,
      UNIQUE (id, office_id)
    );
    CREATE TABLE public.cases (
      id uuid PRIMARY KEY, office_id uuid NOT NULL REFERENCES public.offices(id),
      client_id uuid NOT NULL,
      case_number text NOT NULL, title text NOT NULL, deleted_at timestamptz,
      UNIQUE (id, office_id),
      FOREIGN KEY (client_id, office_id) REFERENCES public.clients(id, office_id) ON DELETE RESTRICT
    );
    CREATE TABLE public.auth_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
      office_id uuid NOT NULL, token_hash text NOT NULL, csrf_hash text NOT NULL,
      expires_at timestamptz NOT NULL, revoked_at timestamptz, last_seen_at timestamptz,
      FOREIGN KEY (user_id, office_id) REFERENCES public.users(id, office_id)
    );
    CREATE TABLE public.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), office_id uuid NOT NULL,
      user_id uuid NOT NULL, action text NOT NULL, entity_type text NOT NULL,
      entity_id uuid NOT NULL, metadata jsonb, ip_address text, user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION public.set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN NEW.updated_at=now(); RETURN NEW; END $fn$;
  `);

  await pool.query(`
    DO $role$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_ci') THEN
        CREATE ROLE dadban_document_runtime_ci LOGIN PASSWORD 'ci-only-runtime-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $role$;
    ALTER ROLE dadban_document_runtime_ci LOGIN PASSWORD 'ci-only-runtime-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  `);

  for (const path of [
    "../migrations/004_case_documents_metadata.sql",
    "../migrations/006_case_document_mutation_idempotency.sql",
    "../migrations/007_case_document_mutation_tombstones.sql",
    "../migrations/008_security_definer_document_actor_lock.sql",
    "../migrations/009_case_reassignment_parent_locks.sql",
    "../migrations/010_api_mutation_idempotency.sql",
    "../migrations/011_api_mutation_idempotency_tombstones.sql",
    "../migrations/012_api_mutation_idempotency_tombstone_guards.sql"
  ]) {
    await pool.query(await readFile(new URL(path, import.meta.url), "utf8"));
  }

  await pool.query(`
    GRANT CONNECT ON DATABASE dadban_runtime_role_test TO dadban_document_runtime_ci;
    REVOKE ALL ON SCHEMA public FROM dadban_document_runtime_ci;
    GRANT USAGE ON SCHEMA public TO dadban_document_runtime_ci;
    REVOKE ALL ON public.users, public.clients, public.cases, public.auth_sessions, public.audit_logs,
      public.case_documents, public.case_document_mutation_idempotency
      FROM dadban_document_runtime_ci;
    GRANT SELECT ON public.users, public.clients, public.cases, public.auth_sessions TO dadban_document_runtime_ci;
    -- PostgreSQL requires UPDATE on at least one column of a FOR UPDATE target.
    -- Keep the permission column-scoped; do not grant table-wide UPDATE on users.
    GRANT UPDATE (last_seen_at, revoked_at) ON public.auth_sessions TO dadban_document_runtime_ci;
    GRANT SELECT ON public.case_documents TO dadban_document_runtime_ci;
    GRANT INSERT (office_id,case_id,title,document_type,description,original_filename,mime_type,size_bytes,document_date,reference_number,confidentiality,idempotency_key,request_fingerprint,created_by,updated_by)
      ON public.case_documents TO dadban_document_runtime_ci;
    GRANT UPDATE (title,document_type,confidentiality,description,original_filename,mime_type,size_bytes,document_date,reference_number,updated_by,updated_at,deleted_at)
      ON public.case_documents TO dadban_document_runtime_ci;
    GRANT INSERT ON public.audit_logs TO dadban_document_runtime_ci;
    GRANT SELECT, INSERT ON public.case_document_mutation_idempotency TO dadban_document_runtime_ci;
    GRANT UPDATE (response_status) ON public.case_document_mutation_idempotency TO dadban_document_runtime_ci;
    GRANT SELECT, INSERT ON public.api_mutation_idempotency TO dadban_document_runtime_ci;
    GRANT UPDATE (resource_id,response_status,response_body,completed_at) ON public.api_mutation_idempotency TO dadban_document_runtime_ci;
  `);

  await pool.query("INSERT INTO offices(id,name) VALUES($1,'Runtime Role Test Office')", [officeId]);
  await pool.query("INSERT INTO users(id,office_id,full_name,email,role) VALUES($1,$2,'Runtime Role Owner','runtime-role@example.test','owner')", [userId,officeId]);
  await pool.query("INSERT INTO clients(id,office_id,full_name) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccc03',$1,'Runtime Role Client')", [officeId]);
  await pool.query("INSERT INTO cases(id,office_id,client_id,case_number,title) VALUES($1,$2,'cccccccc-cccc-4ccc-8ccc-cccccccccc03','RT-001','Runtime Role Test Case')", [caseId,officeId]);
  await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
    [userId,officeId,hash(token),hash(csrf)]
  );

  const roleState = await pool.query(`
    SELECT
      r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
      pg_has_role('dadban_document_runtime_ci','dadban_schema_owner_ci','MEMBER') AS member_schema_owner,
      pg_has_role('dadban_document_runtime_ci','dadban_migrator_ci','MEMBER') AS member_migrator,
      (SELECT r2.rolname FROM pg_class c JOIN pg_roles r2 ON r2.oid=c.relowner
        WHERE c.oid='public.case_document_mutation_idempotency'::regclass) AS idem_owner,
      (SELECT r2.rolname FROM pg_class c JOIN pg_roles r2 ON r2.oid=c.relowner
        WHERE c.oid='public.api_mutation_idempotency'::regclass) AS api_idem_owner,
      has_table_privilege('dadban_document_runtime_ci','public.users','UPDATE') AS can_update_users,
      has_table_privilege('dadban_document_runtime_ci','public.clients','UPDATE') AS can_update_clients,
      has_table_privilege('dadban_document_runtime_ci','public.cases','UPDATE') AS can_update_cases,
      has_column_privilege('dadban_document_runtime_ci','public.clients','deleted_at','UPDATE') AS can_update_client_deleted,
      has_column_privilege('dadban_document_runtime_ci','public.cases','deleted_at','UPDATE') AS can_update_case_deleted,
      has_function_privilege('dadban_document_runtime_ci','public.lock_live_client_parent(uuid,uuid)','EXECUTE') AS can_lock_client,
      has_function_privilege('dadban_document_runtime_ci','public.lock_live_case_client(uuid,uuid)','EXECUTE') AS can_lock_case_client,
      has_function_privilege('dadban_document_runtime_ci','public.lock_live_case_parents(uuid,uuid[])','EXECUTE') AS can_lock_cases,
       has_function_privilege('dadban_document_runtime_ci','public.lock_live_case_reassignment(uuid,uuid,uuid)','EXECUTE') AS can_lock_reassignment,
      has_column_privilege('dadban_document_runtime_ci','public.users','full_name','UPDATE') AS can_update_full_name,
      has_column_privilege('dadban_document_runtime_ci','public.users','role','UPDATE') AS can_update_user_role,
      has_column_privilege('dadban_document_runtime_ci','public.users','is_active','UPDATE') AS can_update_user_active,
      has_column_privilege('dadban_document_runtime_ci','public.users','deleted_at','UPDATE') AS can_update_user_deleted,
      has_table_privilege('dadban_document_runtime_ci','public.audit_logs','SELECT') AS can_read_audit,
      has_table_privilege('dadban_document_runtime_ci','public.audit_logs','UPDATE') AS can_update_audit,
      has_table_privilege('dadban_document_runtime_ci','public.audit_logs','DELETE') AS can_delete_audit,
      has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','DELETE') AS can_delete_idem,
      has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','TRUNCATE') AS can_truncate_idem,
      has_column_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','purged_at','UPDATE') AS can_update_purged_at,
      has_table_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','UPDATE') AS can_update_api_idem_table,
      has_table_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','DELETE') AS can_delete_api_idem,
      has_table_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','TRUNCATE') AS can_truncate_api_idem,
      has_table_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','TRIGGER') AS can_manage_api_idem_triggers,
      has_column_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','response_status','UPDATE') AS can_complete_api_idem,
      has_column_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','response_body_purged','UPDATE') AS can_update_api_purged_flag,
      has_column_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','purged_at','UPDATE') AS can_update_api_purged_at
    FROM pg_roles r WHERE r.rolname='dadban_document_runtime_ci'
  `);
  const role = roleState.rows[0];
  for (const attr of ["rolsuper","rolcreatedb","rolcreaterole","rolinherit","member_schema_owner","member_migrator","can_update_users","can_update_full_name","can_update_user_role","can_update_user_active","can_update_user_deleted","can_update_clients","can_update_cases","can_update_client_deleted","can_update_case_deleted","can_read_audit","can_update_audit","can_delete_audit","can_delete_idem","can_truncate_idem","can_update_purged_at","can_update_api_idem_table","can_delete_api_idem","can_truncate_api_idem","can_manage_api_idem_triggers","can_update_api_purged_flag","can_update_api_purged_at"]) {
    assert.equal(role[attr], false, `runtime role must not have ${attr}`);
  }
  assert.notEqual(role.idem_owner, "dadban_document_runtime_ci", "runtime must not own the idempotency table");
  const runtimeIdentity = await runtimePool.query("SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user");
  assert.deepEqual(runtimeIdentity.rows[0], { role:"dadban_document_runtime_ci", rolsuper:false, rolcreatedb:false, rolcreaterole:false });
  assert.equal(role.can_update_full_name, false, "runtime must not have UPDATE(full_name); row locking is delegated to the SECURITY DEFINER helper");
  for (const attr of ["can_lock_client","can_lock_case_client","can_lock_cases","can_lock_reassignment"]) {
    assert.equal(role[attr], true, `runtime must have EXECUTE on parent lock helper ${attr}`);
  }
  const actorFunctionState = await pool.query(`
    SELECT pg_get_userbyid(p.proowner) AS function_owner,
      p.prosecdef AS security_definer, p.proconfig,
      owner.rolsuper AS owner_superuser, owner.rolcanlogin AS owner_can_login,
      owner.rolcreatedb AS owner_createdb, owner.rolcreaterole AS owner_createrole,
      owner.rolinherit AS owner_inherit,
      has_function_privilege('dadban_document_runtime_ci', p.oid, 'EXECUTE') AS runtime_execute,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute,
      has_table_privilege('dadban_actor_lock_owner','public.users','SELECT') AS owner_select_users,
      has_column_privilege('dadban_actor_lock_owner','public.users','full_name','UPDATE') AS owner_update_full_name,
      has_table_privilege('dadban_actor_lock_owner','public.users','UPDATE') AS owner_table_update_users,
      has_column_privilege('dadban_actor_lock_owner','public.auth_sessions','revoked_at','UPDATE') AS owner_update_revoked_at
    FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
    WHERE p.oid='public.lock_live_document_actor(uuid,uuid,uuid)'::regprocedure
  `);
  const actorFn = actorFunctionState.rows[0];
  assert.ok(actorFn, "SECURITY DEFINER actor lock function must exist");
  assert.equal(actorFn.function_owner, "dadban_actor_lock_owner");
  assert.equal(actorFn.security_definer, true);
  assert.deepEqual(actorFn.proconfig, ["search_path=pg_catalog, pg_temp"]);
  for (const attr of ["owner_superuser","owner_can_login","owner_createdb","owner_createrole","owner_inherit","public_execute","owner_table_update_users"]) {
    assert.equal(actorFn[attr], false, `actor lock unsafe privilege: ${attr}`);
  }
  for (const attr of ["runtime_execute","owner_select_users","owner_update_full_name","owner_update_revoked_at"]) {
    assert.equal(actorFn[attr], true, `actor lock required privilege missing: ${attr}`);
  }
  const parentFunctionState = await pool.query(`
    SELECT p.proname, pg_get_userbyid(p.proowner) AS function_owner,
      p.prosecdef AS security_definer, p.proconfig,
      has_function_privilege('dadban_document_runtime_ci',p.oid,'EXECUTE') AS runtime_execute,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p
    WHERE p.oid IN (
      'public.lock_live_client_parent(uuid,uuid)'::regprocedure,
      'public.lock_live_case_client(uuid,uuid)'::regprocedure,
      'public.lock_live_case_parents(uuid,uuid[])'::regprocedure,
      'public.lock_live_case_reassignment(uuid,uuid,uuid)'::regprocedure
    )
    ORDER BY p.proname
  `);
  assert.equal(parentFunctionState.rowCount, 4, "all four parent lock helpers must exist");
  for (const fn of parentFunctionState.rows) {
    assert.equal(fn.function_owner, "dadban_actor_lock_owner");
    assert.equal(fn.security_definer, true);
    assert.deepEqual(fn.proconfig, ["search_path=pg_catalog, pg_temp"]);
    assert.equal(fn.runtime_execute, true);
    assert.equal(fn.public_execute, false);
  }
  assert.equal((await pool.query("select has_column_privilege('dadban_actor_lock_owner','public.clients','deleted_at','UPDATE') as clients, has_column_privilege('dadban_actor_lock_owner','public.cases','deleted_at','UPDATE') as cases")).rows[0].clients, true);
  assert.equal((await pool.query("select has_column_privilege('dadban_actor_lock_owner','public.cases','deleted_at','UPDATE') as allowed")).rows[0].allowed, true);
  console.log("ACTOR LOCK FUNCTION CATALOG ASSERTIONS:", JSON.stringify(actorFn));
  console.log("PARENT LOCK FUNCTION CATALOG ASSERTIONS:", JSON.stringify(parentFunctionState.rows));
  console.log("PASS: runtime has EXECUTE-only parent locks and no direct UPDATE on clients/cases");

  server = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: apiDatabaseUrl, CORS_ORIGIN: origin, RATE_LIMIT_MODE: "memory" },
    stdio: ["ignore","pipe","pipe"]
  });
  server.stdout.on("data", chunk => { output += chunk.toString(); });
  server.stderr.on("data", chunk => { output += chunk.toString(); });
  await waitHealthy();

  const createPayload = { case_id: caseId, title: "Runtime role metadata", document_type: "evidence", description: "created under least-privilege login", confidentiality: "normal" };
  const createKey = "runtime-create-0001";
  const created = await request("/api/case-documents", { method:"POST", key:createKey, body:createPayload });
  assert.equal(created.status, 201, `create failed under runtime role: ${JSON.stringify(created.body)}`);
  const documentId = created.body.data.id;
  const createReplay = await request("/api/case-documents", { method:"POST", key:createKey, body:createPayload });
  assert.equal(createReplay.status, 200, "same-key create replay should return the original document");
  assert.equal(createReplay.body.idempotent_replay, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM case_documents WHERE id=$1", [documentId])).rows[0].n, 1);

  const patchKey = "runtime-patch-0001";
  const patched = await request(`/api/case-documents/${documentId}`, { method:"PATCH", key:patchKey, body:{title:"Runtime role edited"} });
  assert.equal(patched.status, 200, `edit failed under runtime role: ${JSON.stringify(patched.body)}`);
  const patchReplay = await request(`/api/case-documents/${documentId}`, { method:"PATCH", key:patchKey, body:{title:"Runtime role edited"} });
  assert.equal(patchReplay.status, 200, "same-key PATCH replay should succeed");

  const confidentialityKey = "runtime-class-0001";
  const classified = await request(`/api/case-documents/${documentId}`, { method:"PATCH", key:confidentialityKey, body:{confidentiality:"confidential"} });
  assert.equal(classified.status, 200, `confidentiality change failed under runtime role: ${JSON.stringify(classified.body)}`);
  const classificationReplay = await request(`/api/case-documents/${documentId}`, { method:"PATCH", key:confidentialityKey, body:{confidentiality:"confidential"} });
  assert.equal(classificationReplay.status, 200, "same-key confidentiality replay should succeed");
  const transitionAudit = await pool.query(
    "SELECT metadata FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$2 AND action='update'",
    [officeId,documentId]
  );
  assert.equal(transitionAudit.rowCount, 2, "title and confidentiality changes must each have one audit event");
  assert.deepEqual(transitionAudit.rows[1].metadata.confidentiality_change, {from:"normal",to:"confidential"});

  const deleteKey = "runtime-delete-0001";
  const deleted = await request(`/api/case-documents/${documentId}`, { method:"DELETE", key:deleteKey });
  assert.equal(deleted.status, 204, "soft delete should succeed under runtime role");
  const deleteReplay = await request(`/api/case-documents/${documentId}`, { method:"DELETE", key:deleteKey });
  assert.equal(deleteReplay.status, 204, "same-key DELETE replay should return 204");

  await denied("DELETE FROM public.case_document_mutation_idempotency WHERE office_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid", "DELETE idempotency identity");
  await denied("UPDATE public.case_document_mutation_idempotency SET purged_at=NULL", "UPDATE tombstone marker");
  await denied("TRUNCATE public.case_document_mutation_idempotency", "TRUNCATE idempotency table");
  await denied("ALTER TABLE public.case_document_mutation_idempotency DISABLE TRIGGER ALL", "disable tombstone triggers");

  const counts = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM case_document_mutation_idempotency WHERE office_id=$1 AND user_id=$2) AS idempotency_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3) AS audit_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3 AND action='create') AS create_audit_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3 AND action='update') AS update_audit_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3 AND action='delete') AS delete_audit_rows,
      (SELECT count(*)::int FROM case_documents WHERE id=$3 AND deleted_at IS NOT NULL) AS soft_deleted_documents
  `, [officeId,userId,documentId]);
  assert.deepEqual(counts.rows[0], {
    idempotency_rows:3, audit_rows:4, create_audit_rows:1, update_audit_rows:2, delete_audit_rows:1, soft_deleted_documents:1
  });
  const durableKeys = await pool.query(
    "SELECT idempotency_key,response_status,purged_at FROM case_document_mutation_idempotency WHERE office_id=$1 AND user_id=$2 ORDER BY idempotency_key",
    [officeId,userId]
  );
  assert.equal(durableKeys.rowCount, 3);
  assert.deepEqual(durableKeys.rows.map(row=>row.response_status).sort((a,b)=>a-b), [200,200,204]);
  assert.ok(durableKeys.rows.every(row=>row.purged_at === null));
  console.log(`DIRECT DB ASSERTIONS: case_document_mutation_idempotency=${counts.rows[0].idempotency_rows} audit_logs=${counts.rows[0].audit_rows} create=${counts.rows[0].create_audit_rows} update=${counts.rows[0].update_audit_rows} delete=${counts.rows[0].delete_audit_rows} soft_deleted=${counts.rows[0].soft_deleted_documents}`);
  console.log("PASS: create/replay, edit/replay, confidentiality transition/replay, and delete/replay work over HTTP as the least-privilege runtime login without duplicate audit or idempotency rows");
} catch (error) {
  console.error(error);
  if (output) console.error(output);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise(resolve => server.once("exit", resolve));
  }
  await runtimePool.end();
  await pool.end();
}
