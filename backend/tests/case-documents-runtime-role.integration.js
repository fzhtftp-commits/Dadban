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
const proofSecret = "b".repeat(64);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const makeApiProof = ({ action, sessionId, userId: actorUserId = userId, officeId: actorOfficeId = officeId, key, resourceType, operation, fingerprint, resourceId = null, status = null }) => {
  const payload = ["dadban-idem-v1", action, String(sessionId).toLowerCase(), String(actorUserId).toLowerCase(),
    String(actorOfficeId).toLowerCase(), key, resourceType, operation, fingerprint,
    resourceId == null ? "" : String(resourceId).toLowerCase(), status == null ? "" : String(status)].join("|");
  return crypto.createHmac("sha256", Buffer.from(proofSecret, "hex")).update(payload, "utf8").digest("hex");
};
const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 4 });
const runtimePool = new Pool({ connectionString: apiDatabaseUrl, ssl: false, max: 2 });
let server;
let output = "";
let testRoleCleanupAuthorized = false;

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
  // This shared role is created as NOLOGIN by the earlier tombstone-privilege
  // step in this same disposable job. Assert that precondition so this test
  // can restore it rather than accidentally deleting or permanently enabling it.
  const initialRoles = await pool.query(`
    SELECT rolname, rolcanlogin
    FROM pg_roles
    WHERE rolname IN (
      'dadban_document_runtime_ci',
      'dadban_document_runtime_alt_ci',
      'dadban_case_documents_owner_ci',
      'dadban_case_documents_migrator_ci',
      'dadban_schema_owner_ci',
      'dadban_schema_owner_alt_ci',
      'dadban_migrator_ci',
      'dadban_maintenance_ci'
    )
  `);
  const initialByName = new Map(initialRoles.rows.map(row => [row.rolname, row]));
  assert.equal(initialByName.get("dadban_document_runtime_ci")?.rolcanlogin, false,
    "expected earlier tombstone test to leave the shared runtime role as NOLOGIN");
  for (const roleName of [
    "dadban_document_runtime_alt_ci",
    "dadban_case_documents_owner_ci",
    "dadban_case_documents_migrator_ci"
  ]) {
    assert.equal(initialByName.has(roleName), false,
      `Refusing to reuse pre-existing test-only PostgreSQL role: ${roleName}`);
  }
  // The preceding role-separation step created these roles and intentionally
  // keeps them available for membership assertions later in this same workflow.
  for (const roleName of [
    "dadban_schema_owner_ci",
    "dadban_schema_owner_alt_ci",
    "dadban_migrator_ci",
    "dadban_maintenance_ci"
  ]) {
    assert.equal(initialByName.has(roleName), true,
      `Expected preceding role-separation step to create ${roleName}`);
  }
  // Destructive cleanup is authorized only after confirming the exact role state.
  testRoleCleanupAuthorized = true;

  await pool.query(`
    DROP FUNCTION IF EXISTS public.lock_live_document_actor(uuid,uuid,uuid) CASCADE;
    DROP FUNCTION IF EXISTS public.lock_live_client_parent(uuid,uuid) CASCADE;
    DROP FUNCTION IF EXISTS public.lock_live_case_client(uuid,uuid) CASCADE;
    DROP FUNCTION IF EXISTS public.lock_live_case_parents(uuid,uuid[]) CASCADE;
    DROP FUNCTION IF EXISTS public.prevent_case_document_idempotency_delete() CASCADE;
    DROP FUNCTION IF EXISTS public.prevent_case_document_idempotency_reopen() CASCADE;
    DROP FUNCTION IF EXISTS public.guard_api_mutation_idempotency_identity() CASCADE;
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
    DO $alt_role$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_alt_ci') THEN
        CREATE ROLE dadban_document_runtime_alt_ci LOGIN PASSWORD 'ci-only-alt-runtime-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END $alt_role$;
    ALTER ROLE dadban_document_runtime_alt_ci LOGIN PASSWORD 'ci-only-alt-runtime-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  `);

  for (const path of [
    "../migrations/004_case_documents_metadata.sql",
    "../migrations/006_case_document_mutation_idempotency.sql",
    "../migrations/007_case_document_mutation_tombstones.sql",
    "../migrations/008_security_definer_document_actor_lock.sql",
    "../migrations/009_case_reassignment_parent_locks.sql",
    "../migrations/010_api_mutation_idempotency.sql",
    "../migrations/011_api_mutation_idempotency_tombstones.sql",
    "../migrations/012_api_mutation_idempotency_tombstone_guards.sql",
    "../migrations/013_api_mutation_idempotency_proof_functions.sql",
    "../migrations/014_security_definer_acl_reconciliation.sql"
  ]) {
    const migrationSql = await readFile(new URL(path, import.meta.url), "utf8");
    if (path === "../migrations/014_security_definer_acl_reconciliation.sql") {
      const hmacProxyRole = "dadban_hmac_acl_proxy_ci";
      const hmacProxyPreflight = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [hmacProxyRole]);
      assert.equal(hmacProxyPreflight.rowCount, 0, "refusing to reuse pre-existing HMAC ACL proxy role");
      await pool.query("CREATE ROLE dadban_actor_acl_probe_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT");
      await pool.query("CREATE ROLE " + hmacProxyRole + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT");
      await pool.query("GRANT CREATE ON SCHEMA public TO dadban_actor_acl_probe_ci WITH GRANT OPTION");
      // Seed stale direct table/column grants, grant options, and a transitive
      // role-membership path before migration 014 reconciles the private key.
      await pool.query("GRANT SELECT ON TABLE dadban_private.api_mutation_idempotency_hmac_key TO dadban_actor_acl_probe_ci WITH GRANT OPTION");
      await pool.query("GRANT UPDATE (secret) ON TABLE dadban_private.api_mutation_idempotency_hmac_key TO dadban_actor_acl_probe_ci WITH GRANT OPTION");
      await pool.query("GRANT SELECT (secret) ON TABLE dadban_private.api_mutation_idempotency_hmac_key TO " + hmacProxyRole + " WITH GRANT OPTION");
      await pool.query("GRANT " + hmacProxyRole + " TO dadban_actor_acl_probe_ci");
      const aclSignatures = [
        "public.lock_live_document_actor(uuid,uuid,uuid)","public.lock_live_client_parent(uuid,uuid)",
        "public.lock_live_case_client(uuid,uuid)","public.lock_live_case_parents(uuid,uuid[])",
        "public.lock_live_case_reassignment(uuid,uuid,uuid)",
        "public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)",
        "public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)",
        "public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)"
      ];
      for (const signature of aclSignatures) {
        await pool.query("GRANT EXECUTE ON FUNCTION " + signature + " TO dadban_actor_acl_probe_ci WITH GRANT OPTION");
        await pool.query("GRANT EXECUTE ON FUNCTION " + signature + " TO dadban_document_runtime_ci WITH GRANT OPTION");
      }
      // Seed stale global and schema-scoped default EXECUTE grants from an
      // earlier deployment; migration 014 must prevent future function leaks.
      await pool.query("ALTER DEFAULT PRIVILEGES FOR ROLE dadban_api_idempotency_owner GRANT EXECUTE ON FUNCTIONS TO dadban_actor_acl_probe_ci WITH GRANT OPTION");
      await pool.query("ALTER DEFAULT PRIVILEGES FOR ROLE dadban_api_idempotency_owner IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO dadban_hmac_acl_proxy_ci WITH GRANT OPTION");
      await pool.query("ALTER DEFAULT PRIVILEGES FOR ROLE dadban_actor_lock_owner IN SCHEMA dadban_private GRANT EXECUTE ON FUNCTIONS TO dadban_hmac_acl_proxy_ci WITH GRANT OPTION");
    }
    if (path === "../migrations/008_security_definer_document_actor_lock.sql") {
      // Seed stale schema CREATE privilege before the first successful migration.
      // Migration 008 must normalize this drift; a failed membership preflight
      // must still roll back atomically.
      await pool.query(`
        DO $owner$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_actor_lock_owner') THEN
            CREATE ROLE dadban_actor_lock_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
          END IF;
        END
        $owner$;
        GRANT CREATE ON SCHEMA public TO dadban_actor_lock_owner;
      `);
      // A runtime membership could allow SET ROLE or inherit privileges. Migration
      // 008 must reject it before creating any SECURITY DEFINER actor-lock helper.
      const probeRole = "dadban_actor_runtime_membership_probe_ci";
      const preflight = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [probeRole]);
      assert.equal(preflight.rowCount, 0, "refusing to reuse pre-existing migration-008 runtime membership probe role");
      await pool.query(`CREATE ROLE ${probeRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      let migrationClient;
      try {
        await pool.query(`GRANT ${probeRole} TO dadban_document_runtime_ci`);
        migrationClient = await pool.connect();
        let rejected = false;
        try {
          await migrationClient.query(migrationSql);
        } catch (error) {
          rejected = /runtime role dadban_document_runtime_ci must not participate in role memberships/.test(error.message);
          await migrationClient.query("ROLLBACK").catch(() => {});
          if (!rejected) throw error;
        }
        assert.equal(rejected, true, "migration 008 must reject compromised runtime role membership");
        const absent = await pool.query("SELECT to_regprocedure('public.lock_live_document_actor(uuid,uuid,uuid)') AS fn");
        assert.equal(absent.rows[0].fn, null, "failed migration 008 must not leave actor-lock SECURITY DEFINER function behind");
        console.log("PASS: migration 008 rejects runtime-role membership and rolls back function creation");
      } finally {
        migrationClient?.release();
        await pool.query(`REVOKE ${probeRole} FROM dadban_document_runtime_ci`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
      }
    }
    if (path === "../migrations/009_case_reassignment_parent_locks.sql") {
      // Seed stale CREATE privilege after migration 008; migration 009 must
      // independently normalize owner ACL drift.
      await pool.query("GRANT CREATE ON SCHEMA public TO dadban_actor_lock_owner");
      // Replaying migration 009 with a compromised definer-owner membership must
      // fail before function creation/ownership transfer and roll back atomically.
      const probeRole = "dadban_actor_lock_membership_probe_ci";
      const preflight = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [probeRole]);
      assert.equal(preflight.rowCount, 0, "refusing to reuse pre-existing migration-009 membership probe role");
      await pool.query(`CREATE ROLE ${probeRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      let migrationClient;
      try {
        await pool.query(`GRANT dadban_actor_lock_owner TO ${probeRole}`);
        migrationClient = await pool.connect();
        let rejected = false;
        try {
          await migrationClient.query(migrationSql);
        } catch (error) {
          rejected = /dadban_actor_lock_owner must not participate in role memberships/.test(error.message);
          await migrationClient.query("ROLLBACK").catch(() => {});
          if (!rejected) throw error;
        }
        assert.equal(rejected, true, "migration 009 must reject compromised SECURITY DEFINER owner membership");
        const absent = await pool.query("SELECT to_regprocedure('public.lock_live_case_reassignment(uuid,uuid,uuid)') AS fn");
        assert.equal(absent.rows[0].fn, null, "failed migration 009 must not leave the SECURITY DEFINER function behind");
        console.log("PASS: migration 009 rejects owner-role membership and rolls back function creation");
      } finally {
        migrationClient?.release();
        await pool.query(`REVOKE dadban_actor_lock_owner FROM ${probeRole}`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
      }

      // Membership drift can happen after migration 008; 009 must re-check it
      // before granting the reassignment helper, not rely on the earlier guard.
      const runtimeProbe = "dadban_case_reassign_runtime_membership_probe_ci";
      const runtimePreflight = await pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [runtimeProbe]);
      assert.equal(runtimePreflight.rowCount, 0, "refusing to reuse pre-existing migration-009 runtime membership probe role");
      await pool.query(`CREATE ROLE ${runtimeProbe} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      let runtimeMigrationClient;
      try {
        await pool.query(`GRANT ${runtimeProbe} TO dadban_document_runtime_ci`);
        runtimeMigrationClient = await pool.connect();
        let rejected = false;
        try {
          await runtimeMigrationClient.query(migrationSql);
        } catch (error) {
          rejected = /runtime role dadban_document_runtime_ci must not participate in role memberships/.test(error.message);
          await runtimeMigrationClient.query("ROLLBACK").catch(() => {});
          if (!rejected) throw error;
        }
        assert.equal(rejected, true, "migration 009 must reject runtime membership drift after migration 008");
        const absent = await pool.query("SELECT to_regprocedure('public.lock_live_case_reassignment(uuid,uuid,uuid)') AS fn");
        assert.equal(absent.rows[0].fn, null, "failed migration 009 must not leave reassignment helper behind");
        console.log("PASS: migration 009 rejects runtime membership drift and rolls back function creation");
      } finally {
        runtimeMigrationClient?.release();
        await pool.query(`REVOKE ${runtimeProbe} FROM dadban_document_runtime_ci`).catch(() => {});
        await pool.query(`DROP ROLE IF EXISTS ${runtimeProbe}`);
      }
    }
    await pool.query(migrationSql);

    // Assert the successful migration revoked stale CREATE on the shared schema.
    if (path === "../migrations/008_security_definer_document_actor_lock.sql" ||
        path === "../migrations/009_case_reassignment_parent_locks.sql") {
      const createStillGranted = await pool.query(
        "SELECT has_schema_privilege('dadban_actor_lock_owner','public','CREATE') AS allowed"
      );
      assert.equal(createStillGranted.rows[0].allowed, false,
        path + " must revoke stale CREATE on public from actor-lock owner");
      console.log("PASS: " + path + " removes stale CREATE on public from SECURITY DEFINER owner");

    }
    if (path === "../migrations/014_security_definer_acl_reconciliation.sql") {
      const aclSignatures = [
        "public.lock_live_document_actor(uuid,uuid,uuid)","public.lock_live_client_parent(uuid,uuid)",
        "public.lock_live_case_client(uuid,uuid)","public.lock_live_case_parents(uuid,uuid[])",
        "public.lock_live_case_reassignment(uuid,uuid,uuid)",
        "public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)",
        "public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)",
        "public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)"
      ];
      try {
        for (const signature of aclSignatures) {
          const state = await pool.query(
            "SELECT has_function_privilege($1,$2,'EXECUTE') AS probe_execute, has_function_privilege($3,$2,'EXECUTE') AS runtime_execute, " +
            "EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid=$2::regprocedure AND r.rolname=$3 AND a.privilege_type='EXECUTE' AND a.is_grantable) AS runtime_grant_option, " +
            "EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$2::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute",
            ["dadban_actor_acl_probe_ci",signature,"dadban_document_runtime_ci"]);
          assert.equal(state.rows[0].probe_execute,false,signature+" must not retain stale direct EXECUTE");
          assert.equal(state.rows[0].runtime_execute,true,signature+" must retain approved runtime EXECUTE");
          assert.equal(state.rows[0].runtime_grant_option,false,signature+" must not let runtime delegate EXECUTE");
          assert.equal(state.rows[0].public_execute,false,signature+" must not be executable by PUBLIC");
        }
        const defaults = await pool.query(
          "SELECT count(*)::int AS n FROM pg_default_acl d JOIN pg_roles r ON r.oid=d.defaclrole CROSS JOIN LATERAL aclexplode(d.defaclacl) a " +
          "WHERE r.rolname IN ('dadban_actor_lock_owner','dadban_api_idempotency_owner') AND d.defaclobjtype='f' " +
          "AND a.privilege_type='EXECUTE' AND a.grantee<>d.defaclrole");
        assert.equal(defaults.rows[0].n,0,"definer owners must not retain PUBLIC or non-owner default EXECUTE grants in any schema scope");
        const schemaCreate = await pool.query(
          "SELECT has_schema_privilege($1,'public','CREATE') AS effective_create, " +
          "EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a " +
          "WHERE n.nspname='public' AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.privilege_type='CREATE') AS explicit_create",
          ["dadban_actor_acl_probe_ci"]);
        assert.equal(schemaCreate.rows[0].effective_create,false,"unapproved role must not retain effective CREATE on public");
        assert.equal(schemaCreate.rows[0].explicit_create,false,"stale explicit CREATE ACL must be removed from public");

        const hmacAcl = await pool.query(`
          SELECT pg_get_userbyid(c.relowner) AS table_owner,
            has_table_privilege('dadban_actor_acl_probe_ci',c.oid,'SELECT') AS probe_table_select,
            has_table_privilege('dadban_actor_acl_probe_ci',c.oid,'INSERT') AS probe_table_insert,
            has_column_privilege('dadban_actor_acl_probe_ci',c.oid,'secret','SELECT') AS probe_secret_select,
            has_column_privilege('dadban_actor_acl_probe_ci',c.oid,'secret','UPDATE') AS probe_secret_update,
            has_column_privilege('dadban_hmac_acl_proxy_ci',c.oid,'secret','SELECT') AS proxy_secret_select,
            has_table_privilege('dadban_api_idempotency_owner',c.oid,'SELECT') AS definer_select,
            has_table_privilege('dadban_api_idempotency_owner',c.oid,'INSERT') AS definer_insert,
            has_table_privilege('dadban_api_idempotency_owner',c.oid,'UPDATE') AS definer_update,
            has_table_privilege('dadban_api_idempotency_owner',c.oid,'DELETE') AS definer_delete,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
              WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='dadban_actor_acl_probe_ci')) AS probe_table_acl,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
              WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='dadban_hmac_acl_proxy_ci')) AS proxy_table_acl,
            EXISTS (SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
              WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped
                AND a.grantee IN ((SELECT oid FROM pg_roles WHERE rolname='dadban_actor_acl_probe_ci'),
                                  (SELECT oid FROM pg_roles WHERE rolname='dadban_hmac_acl_proxy_ci'))) AS stale_column_acl,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
              WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='dadban_api_idempotency_owner')
                AND a.privilege_type='SELECT' AND a.is_grantable) AS definer_select_grantable,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
              WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='dadban_api_idempotency_owner')
                AND a.privilege_type <> 'SELECT') AS definer_unapproved_table_acl,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
              WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='dadban_api_idempotency_owner')
                AND a.is_grantable) AS definer_any_grantable,
            EXISTS (SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
              WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped
                AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='dadban_api_idempotency_owner')) AS definer_column_acl,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
              WHERE a.grantee=0) AS public_table_acl,
            EXISTS (SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a
              WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee=0) AS public_column_acl
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='dadban_private' AND c.relname='api_mutation_idempotency_hmac_key'
        `);
        assert.equal(hmacAcl.rowCount,1,"private HMAC key table must exist");
        const hmac = hmacAcl.rows[0];
        assert.ok(!["dadban_document_runtime_ci","dadban_document_runtime","dadban_api_idempotency_owner"].includes(hmac.table_owner),
          "private HMAC key table must not be owned by an application runtime or SECURITY DEFINER owner");
        assert.equal(hmac.probe_table_select,false,"stale direct table SELECT must be revoked");
        assert.equal(hmac.probe_table_insert,false,"unapproved role must not insert key rows");
        assert.equal(hmac.probe_secret_select,false,"stale direct column SELECT must be revoked");
        assert.equal(hmac.probe_secret_update,false,"stale direct column UPDATE must be revoked");
        assert.equal(hmac.proxy_secret_select,false,"column privileges through an intermediary role must be revoked");
        assert.equal(hmac.probe_table_acl,false,"stale direct table ACL must be removed");
        assert.equal(hmac.proxy_table_acl,false,"intermediary table ACL must be removed");
        assert.equal(hmac.stale_column_acl,false,"stale column ACLs must be removed from both probe roles");
        assert.equal(hmac.definer_select,true,"proof-function owner must retain required SELECT");
        assert.equal(hmac.definer_insert,false,"proof-function owner must not insert key rows");
        assert.equal(hmac.definer_update,false,"proof-function owner must not update key material");
        assert.equal(hmac.definer_delete,false,"proof-function owner must not delete key rows");
        assert.equal(hmac.definer_select_grantable,false,"proof-function owner SELECT must not have GRANT OPTION");
        assert.equal(hmac.definer_unapproved_table_acl,false,"proof-function owner must retain only plain table SELECT");
        assert.equal(hmac.definer_any_grantable,false,"proof-function owner must have no table GRANT OPTION");
        assert.equal(hmac.definer_column_acl,false,"proof-function owner must not retain separate column-level grants");
        assert.equal(hmac.public_table_acl,false,"PUBLIC must have no explicit table ACL");
        assert.equal(hmac.public_column_acl,false,"PUBLIC must have no explicit column ACL");
        console.log("PASS: migration 014 reconciles HMAC key table/column ACLs, transitive-role grants, and grant options");
        console.log("PASS: migration 014 removes stale EXECUTE grants, runtime grant options, PUBLIC EXECUTE, unsafe definer defaults, and stale public-schema CREATE grants");
      } finally {
        await pool.query("REVOKE dadban_hmac_acl_proxy_ci FROM dadban_actor_acl_probe_ci").catch(()=>{});
        await pool.query("DROP OWNED BY dadban_actor_acl_probe_ci").catch(()=>{});
        await pool.query("DROP OWNED BY dadban_hmac_acl_proxy_ci").catch(()=>{});
        await pool.query("DROP ROLE IF EXISTS dadban_actor_acl_probe_ci");
        await pool.query("DROP ROLE IF EXISTS dadban_hmac_acl_proxy_ci");
      }
    }

  }

  // Dedicated test database only: model the schema-owner/migrator trust boundary for case_documents.
  await pool.query(`
    DO $owner_roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_owner_ci') THEN
        CREATE ROLE dadban_case_documents_owner_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_migrator_ci') THEN
        CREATE ROLE dadban_case_documents_migrator_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      END IF;
    END
    $owner_roles$;
    ALTER ROLE dadban_case_documents_owner_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    ALTER ROLE dadban_case_documents_migrator_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT dadban_case_documents_owner_ci TO dadban_case_documents_migrator_ci;
    ALTER TABLE public.case_documents OWNER TO dadban_case_documents_owner_ci;
  `);
  const documentOwner = await pool.query(`
    SELECT r.rolname AS owner_name, r.rolsuper, r.rolcanlogin, r.rolcreaterole,
           pg_has_role('dadban_document_runtime_ci', r.oid, 'MEMBER') AS runtime_member_of_owner
    FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid='public.case_documents'::regclass
  `);
  assert.equal(documentOwner.rowCount, 1);
  assert.equal(documentOwner.rows[0].owner_name, "dadban_case_documents_owner_ci");
  assert.equal(documentOwner.rows[0].rolsuper, false);
  assert.equal(documentOwner.rows[0].rolcanlogin, false);
  assert.equal(documentOwner.rows[0].rolcreaterole, false);
  assert.equal(documentOwner.rows[0].runtime_member_of_owner, false);
  const runtimeOwnerPath = await pool.query(`
    WITH RECURSIVE memberships(role_oid) AS (
      SELECT m.roleid FROM pg_auth_members m
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname='dadban_document_runtime_ci')
      UNION
      SELECT m.roleid FROM pg_auth_members m JOIN memberships x ON m.member=x.role_oid
    )
    SELECT r.rolname FROM memberships x JOIN pg_roles r ON r.oid=x.role_oid
    WHERE r.rolname IN ('dadban_case_documents_owner_ci','dadban_case_documents_migrator_ci')
  `);
  assert.equal(runtimeOwnerPath.rowCount, 0, "runtime must have no direct or transitive membership in case-document owner/migrator roles");
  const migrationCanAssumeOwner = await pool.query(`
    SELECT pg_has_role('dadban_case_documents_migrator_ci','dadban_case_documents_owner_ci','MEMBER') AS member,
           pg_has_role('dadban_case_documents_migrator_ci','dadban_case_documents_owner_ci','USAGE') AS can_set_role
  `);
  assert.equal(migrationCanAssumeOwner.rows[0].member, true);
  console.log("CASE DOCUMENT OWNER CATALOG:", JSON.stringify(documentOwner.rows[0]));
  console.log("PASS: case_documents owner is non-login/non-privileged; runtime has no direct or transitive owner/migrator membership; migrator membership is explicit");

  await pool.query("UPDATE dadban_private.api_mutation_idempotency_hmac_key SET secret=decode($1, 'hex') WHERE singleton=true", [proofSecret]);
  await pool.query(`
    GRANT CONNECT ON DATABASE dadban_runtime_role_test TO dadban_document_runtime_ci;
    REVOKE ALL ON SCHEMA public FROM dadban_document_runtime_ci;
    GRANT USAGE ON SCHEMA public TO dadban_document_runtime_ci;
    GRANT USAGE ON SCHEMA public TO dadban_document_runtime_alt_ci;
    REVOKE ALL ON public.users, public.clients, public.cases, public.auth_sessions, public.audit_logs,
      public.case_documents, public.case_document_mutation_idempotency, public.api_mutation_idempotency
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
  `);

  await pool.query("INSERT INTO offices(id,name) VALUES($1,'Runtime Role Test Office')", [officeId]);
  await pool.query("INSERT INTO users(id,office_id,full_name,email,role) VALUES($1,$2,'Runtime Role Owner','runtime-role@example.test','owner')", [userId,officeId]);
  await pool.query("INSERT INTO clients(id,office_id,full_name) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccc03',$1,'Runtime Role Client')", [officeId]);
  await pool.query("INSERT INTO cases(id,office_id,client_id,case_number,title) VALUES($1,$2,'cccccccc-cccc-4ccc-8ccc-cccccccccc03','RT-001','Runtime Role Test Case')", [caseId,officeId]);
  await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
    [userId,officeId,hash(token),hash(csrf)]
  );
  const officeB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const userB = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
  const clientB = "dddddddd-dddd-4ddd-8ddd-dddddddddd02";
  const caseB = "dddddddd-dddd-4ddd-8ddd-dddddddddd03";
  const transferDoc = "dddddddd-dddd-4ddd-8ddd-dddddddddd04";
  await pool.query("INSERT INTO offices(id,name) VALUES($1,'Transfer Target Office')", [officeB]);
  await pool.query("INSERT INTO users(id,office_id,full_name,email,role) VALUES($1,$2,'Transfer Target User','transfer-target@example.test','owner')", [userB,officeB]);
  await pool.query("INSERT INTO clients(id,office_id,full_name) VALUES($1,$2,'Transfer Target Client')", [clientB,officeB]);
  await pool.query("INSERT INTO cases(id,office_id,client_id,case_number,title) VALUES($1,$2,$3,'RT-002','Transfer Target Case')", [caseB,officeB,clientB]);
  await pool.query(`
    INSERT INTO case_documents(id,office_id,case_id,title,document_type,confidentiality,created_by,updated_by)
    VALUES($1,$2,$3,'Rollback ownership probe','evidence','normal',$4,$4)
  `, [transferDoc,officeId,caseId,userId]);
  const auditBeforeTransfer = Number((await pool.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='case_document' AND entity_id=$1", [transferDoc]
  )).rows[0].n);
  const transfer = await pool.connect();
  try {
    await transfer.query("BEGIN");
    await transfer.query("SET LOCAL ROLE dadban_case_documents_migrator_ci");
    await transfer.query("SET LOCAL ROLE dadban_case_documents_owner_ci");
    await transfer.query(`
      UPDATE public.case_documents
      SET office_id=$2, case_id=$3, created_by=$4, updated_by=$4
      WHERE id=$1
    `, [transferDoc,officeB,caseB,userB]);
    const moved = await transfer.query(
      "SELECT office_id,case_id,created_by,updated_by FROM public.case_documents WHERE id=$1", [transferDoc]
    );
    assert.deepEqual(moved.rows[0], {office_id:officeB,case_id:caseB,created_by:userB,updated_by:userB});
    // Observe audit from the admin connection: the runtime/migrator path must not gain audit read privileges just for this assertion.
    const auditDuringTransfer = Number((await pool.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='case_document' AND entity_id=$1", [transferDoc]
    )).rows[0].n);
    assert.equal(auditDuringTransfer, auditBeforeTransfer, "privileged direct SQL does not automatically emit application audit");
    await transfer.query("ROLLBACK");
  } finally {
    transfer.release();
  }
  const restored = await pool.query(
    "SELECT office_id,case_id,created_by,updated_by FROM public.case_documents WHERE id=$1", [transferDoc]
  );
  assert.deepEqual(restored.rows[0], {office_id:officeId,case_id:caseId,created_by:userId,updated_by:userId});
  const auditAfterRollback = Number((await pool.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='case_document' AND entity_id=$1", [transferDoc]
  )).rows[0].n);
  assert.equal(auditAfterRollback, auditBeforeTransfer);
  console.log("PASS: migration role can coordinate office_id/case_id/created_by/updated_by under owner authority without application audit; transaction rollback restores all values and audit count");


  const liveSessionId = (await pool.query("SELECT id FROM auth_sessions WHERE token_hash=$1", [hash(token)])).rows[0].id;
  const proofFingerprint = "a".repeat(64);
  const reserveSql = "SELECT public.reserve_api_mutation_idempotency($1,$2,$3,$4,$5,$6,$7,$8) AS inserted";
  const lookupSql = "SELECT * FROM public.read_api_mutation_idempotency($1,$2,$3,$4,$5,$6,$7,$8)";
  const completeSql = "SELECT public.complete_api_mutation_idempotency($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS completed";
  const reserveArgs = (sessionId, actorUserId, key, proof, resourceType = "case", operation = "POST", fingerprint = proofFingerprint, actorOfficeId = officeId) =>
    [sessionId, actorUserId, actorOfficeId, key, resourceType, operation, fingerprint, proof];
  const makeReserveProof = (sessionId, actorUserId, key, resourceType = "case", operation = "POST", fingerprint = proofFingerprint, actorOfficeId = officeId) =>
    makeApiProof({ action:"reserve", sessionId, userId:actorUserId, officeId:actorOfficeId, key, resourceType, operation, fingerprint });
  const makeCompleteProof = (sessionId, actorUserId, key, resourceId, status, resourceType = "case", operation = "POST", fingerprint = proofFingerprint, actorOfficeId = officeId) =>
    makeApiProof({ action:"complete", sessionId, userId:actorUserId, officeId:actorOfficeId, key, resourceType, operation, fingerprint, resourceId, status });

  await denied("INSERT INTO public.api_mutation_idempotency(office_id,user_id,idempotency_key,resource_type,operation,request_fingerprint) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','cccccccc-cccc-4ccc-8ccc-cccccccccc01','direct-runtime-0001','case','POST','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')", "direct API idempotency reservation INSERT");
  await denied("UPDATE public.api_mutation_idempotency SET resource_id='cccccccc-cccc-4ccc-8ccc-cccccccccc02',response_status=201,response_body='{}'::jsonb,completed_at=now()", "direct API idempotency completion UPDATE");
  await denied("SELECT * FROM public.api_mutation_idempotency", "direct API idempotency table read");
  await denied("UPDATE public.case_documents SET office_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid WHERE false", "direct document office ownership reassignment");
  await denied("UPDATE public.case_documents SET case_id='cccccccc-cccc-4ccc-8ccc-cccccccccc02'::uuid WHERE false", "direct document parent-case reassignment");

  const validKey = "runtime-proof-valid-001";
  const validReservation = await runtimePool.query(reserveSql, reserveArgs(liveSessionId, userId, validKey, makeReserveProof(liveSessionId, userId, validKey)));
  assert.equal(validReservation.rows[0].inserted, true, "valid live-session proof must reserve a key");
  const validProofReplay = await runtimePool.query(
    reserveSql, reserveArgs(liveSessionId, userId, validKey, makeReserveProof(liveSessionId, userId, validKey))
  );
  assert.equal(validProofReplay.rows[0].inserted, false, "replaying a valid reservation proof for the same identity must not create a second reservation");
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(
      liveSessionId, userId, "runtime-proof-rebound-001",
      makeReserveProof(liveSessionId, userId, validKey)
    )),
    error => error.code === "42501",
    "a valid proof must not be replayable against a different idempotency key"
  );
  const reboundTypeKey = "runtime-proof-type-bind-001";
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(
      liveSessionId,userId,reboundTypeKey,
      makeReserveProof(liveSessionId,userId,reboundTypeKey,"case","POST",proofFingerprint),
      "client","POST",proofFingerprint
    )),
    error => error.code === "42501",
    "HMAC proof must bind the resource type"
  );
  const reboundOperationKey = "runtime-proof-operation-bind-001";
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(
      liveSessionId,userId,reboundOperationKey,
      makeReserveProof(liveSessionId,userId,reboundOperationKey,"case","POST",proofFingerprint),
      "case","PATCH",proofFingerprint
    )),
    error => error.code === "42501",
    "HMAC proof must bind the operation"
  );
  const reboundFingerprintKey = "runtime-proof-fingerprint-bind-001";
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(
      liveSessionId,userId,reboundFingerprintKey,
      makeReserveProof(liveSessionId,userId,reboundFingerprintKey,"case","POST",proofFingerprint),
      "case","POST","c".repeat(64)
    )),
    error => error.code === "42501",
    "HMAC proof must bind the request fingerprint"
  );
  const reboundOfficeKey = "runtime-proof-office-bind-001";
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(
      liveSessionId,userId,reboundOfficeKey,
      makeReserveProof(liveSessionId,userId,reboundOfficeKey,"case","POST",proofFingerprint,officeId),
      "case","POST",proofFingerprint,"dddddddd-dddd-4ddd-8ddd-dddddddddddd"
    )),
    error => error.code === "42501",
    "HMAC proof must bind the office identity"
  );

  // Lookup and completion are separate proof domains; each must independently
  // bind every mutation identity field instead of relying on reservation checks.
  const lookupBindingCases = [
    ["resource type", "runtime-proof-lookup-type-001", "client", "POST", proofFingerprint, officeId],
    ["operation", "runtime-proof-lookup-operation-001", "case", "PATCH", proofFingerprint, officeId],
    ["request fingerprint", "runtime-proof-lookup-fingerprint-001", "case", "POST", "d".repeat(64), officeId],
    ["office identity", "runtime-proof-lookup-office-001", "case", "POST", proofFingerprint, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]
  ];
  for (const [label, key, changedType, changedOperation, changedFingerprint, changedOffice] of lookupBindingCases) {
    await runtimePool.query(reserveSql, reserveArgs(liveSessionId, userId, key, makeReserveProof(liveSessionId, userId, key)));
    await assert.rejects(
      runtimePool.query(lookupSql, [
        liveSessionId, userId, changedOffice, key, changedType, changedOperation, changedFingerprint,
        makeApiProof({ action:"lookup", sessionId:liveSessionId, key, resourceType:"case", operation:"POST", fingerprint:proofFingerprint, officeId })
      ]),
      error => error.code === "42501",
      `lookup HMAC proof must bind the ${label}`
    );
  }
  console.log("PASS: lookup HMAC cannot be rebound across resource type, operation, fingerprint, or office");

  const completionBindingCases = [
    ["resource type", "runtime-proof-complete-type-001", "client", "POST", proofFingerprint, officeId, caseId, 201],
    ["operation", "runtime-proof-complete-operation-001", "case", "PATCH", proofFingerprint, officeId, caseId, 201],
    ["request fingerprint", "runtime-proof-complete-fingerprint-001", "case", "POST", "e".repeat(64), officeId, caseId, 201],
    ["office identity", "runtime-proof-complete-office-001", "case", "POST", proofFingerprint, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", caseId, 201],
    ["resource id", "runtime-proof-complete-resource-001", "case", "POST", proofFingerprint, officeId, "cccccccc-cccc-4ccc-8ccc-cccccccccc03", 201],
    ["response status", "runtime-proof-complete-status-001", "case", "POST", proofFingerprint, officeId, caseId, 202]
  ];
  for (const [label, key, changedType, changedOperation, changedFingerprint, changedOffice, changedResourceId, changedStatus] of completionBindingCases) {
    await runtimePool.query(reserveSql, reserveArgs(liveSessionId, userId, key, makeReserveProof(liveSessionId, userId, key)));
    await assert.rejects(
      runtimePool.query(completeSql, [
        liveSessionId, userId, changedOffice, key, changedType, changedOperation, changedFingerprint, changedResourceId, changedStatus,
        makeCompleteProof(liveSessionId, userId, key, caseId, 201)
      ]),
      error => error.code === "42501",
      `completion HMAC proof must bind the ${label}`
    );
  }
  console.log("PASS: completion HMAC cannot be rebound across mutation identity, resource id, or response status");

  console.log("PASS: reservation HMAC cannot be rebound across resource type, operation, fingerprint, or office");

  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(liveSessionId, userId, "runtime-proof-invalid-001", "0".repeat(64))),
    error => error.code === "42501",
    "an invalid proof must not reserve a key"
  );
  await assert.rejects(
    runtimePool.query(lookupSql, [
      liveSessionId, userId, officeId, validKey, "case", "POST", proofFingerprint, "0".repeat(64)
    ]),
    error => error.code === "42501",
    "an invalid lookup proof must not read an existing reservation"
  );
  console.log("PASS: direct reservation/completion SQL is denied and invalid proof is rejected");

  await denied("SELECT secret FROM dadban_private.api_mutation_idempotency_hmac_key", "reading API idempotency HMAC key material");
  await assert.rejects(
    runtimePool.query(completeSql, [
      liveSessionId, userId, officeId, validKey, "case", "POST", proofFingerprint, caseId, 201, "0".repeat(64)
    ]),
    error => error.code === "42501",
    "invalid completion proof must be rejected"
  );
  console.log("PASS: runtime cannot read the HMAC key and invalid completion proof is rejected");

  const completed = await runtimePool.query(completeSql, [
    liveSessionId, userId, officeId, validKey, "case", "POST", proofFingerprint, caseId, 201,
    makeCompleteProof(liveSessionId, userId, validKey, caseId, 201)
  ]);
  assert.equal(completed.rows[0].completed, true, "valid proof must complete exactly one pending reservation");
  const changedCompletion = await runtimePool.query(completeSql, [
    liveSessionId, userId, officeId, validKey, "case", "POST", proofFingerprint, "cccccccc-cccc-4ccc-8ccc-cccccccccc03", 202,
    makeCompleteProof(liveSessionId, userId, validKey, "cccccccc-cccc-4ccc-8ccc-cccccccccc03", 202)
  ]);
  assert.equal(changedCompletion.rows[0].completed, false, "completed result must not be rewritten");
  await denied("UPDATE public.api_mutation_idempotency SET response_status=202,response_body='{}'::jsonb WHERE idempotency_key='runtime-proof-valid-001'", "direct completed-result rewrite");
  await pool.query("UPDATE public.api_mutation_idempotency SET response_body=NULL,response_body_purged=true,purged_at=clock_timestamp() WHERE office_id=$1 AND user_id=$2 AND idempotency_key=$3", [officeId,userId,validKey]);
  await denied("UPDATE public.api_mutation_idempotency SET response_body_purged=false,purged_at=NULL WHERE idempotency_key='runtime-proof-valid-001'", "direct tombstone reversal");
  const replayReservation = await runtimePool.query(reserveSql, reserveArgs(liveSessionId, userId, validKey, makeReserveProof(liveSessionId, userId, validKey)));
  assert.equal(replayReservation.rows[0].inserted, false, "replay after purge must retain the original key tombstone");
  const tombstone = await runtimePool.query(lookupSql, [
    liveSessionId, userId, officeId, validKey, "case", "POST", proofFingerprint,
    makeApiProof({ action:"lookup", sessionId:liveSessionId, key:validKey, resourceType:"case", operation:"POST", fingerprint:proofFingerprint })
  ]);
  assert.equal(tombstone.rows[0].response_status, 201);
  assert.equal(tombstone.rows[0].response_body_purged, true);
  assert.ok(tombstone.rows[0].purged_at);
  console.log("PASS: one-way completion and tombstone replay protection");

  // Race completion against cleanup while completion owns an uncommitted row version.
  // Cleanup must not wait on or purge a reservation that is not yet committed as complete.
  const completionPurgeKey = "runtime-proof-complete-purge-001";
  const completionPurgeReservation = await runtimePool.query(reserveSql, reserveArgs(
    liveSessionId, userId, completionPurgeKey,
    makeReserveProof(liveSessionId, userId, completionPurgeKey)
  ));
  assert.equal(completionPurgeReservation.rows[0].inserted, true);
  const completingClient = await runtimePool.connect();
  const cleanupRacingClient = await pool.connect();
  try {
    await completingClient.query("BEGIN");
    const completionInFlight = await completingClient.query(completeSql, [
      liveSessionId, userId, officeId, completionPurgeKey, "case", "POST",
      proofFingerprint, caseId, 201,
      makeCompleteProof(liveSessionId, userId, completionPurgeKey, caseId, 201)
    ]);
    assert.equal(completionInFlight.rows[0].completed, true);
    await cleanupRacingClient.query("BEGIN");
    await cleanupRacingClient.query("SET LOCAL lock_timeout = '3s'");
    let cleanupSettled = false;
    const cleanupPromise = cleanupRacingClient.query(
      "UPDATE public.api_mutation_idempotency SET response_body=NULL,response_body_purged=true,purged_at=clock_timestamp() WHERE office_id=$1 AND user_id=$2 AND idempotency_key=$3 AND completed_at IS NOT NULL",
      [officeId, userId, completionPurgeKey]
    ).then(value => { cleanupSettled = true; return { value }; }, error => { cleanupSettled = true; return { error }; });
    await delay(100);
    assert.equal(cleanupSettled, true, "cleanup must skip the still-uncommitted completion, not block on it");
    await completingClient.query("COMMIT");
    const cleanupOutcome = await cleanupPromise;
    assert.equal(cleanupOutcome.error, undefined, "cleanup against the old incomplete version should finish safely");
    assert.equal(cleanupOutcome.value.rowCount, 0, "cleanup must not purge an uncommitted completion");
    await cleanupRacingClient.query("COMMIT");
  } finally {
    await completingClient.query("ROLLBACK").catch(() => {});
    await cleanupRacingClient.query("ROLLBACK").catch(() => {});
    completingClient.release();
    cleanupRacingClient.release();
  }
  const cleanupAfterCommittedCompletion = await pool.query(
    "UPDATE public.api_mutation_idempotency SET response_body=NULL,response_body_purged=true,purged_at=clock_timestamp() WHERE office_id=$1 AND user_id=$2 AND idempotency_key=$3 AND completed_at IS NOT NULL",
    [officeId, userId, completionPurgeKey]
  );
  assert.equal(cleanupAfterCommittedCompletion.rowCount, 1, "cleanup may purge after completion is committed");
  const completionPurgeReplay = await runtimePool.query(
    reserveSql, reserveArgs(liveSessionId, userId, completionPurgeKey, makeReserveProof(liveSessionId, userId, completionPurgeKey))
  );
  assert.equal(completionPurgeReplay.rows[0].inserted, false, "cleanup must not reopen a completed idempotency key");
  const completionPurgeTombstone = await runtimePool.query(lookupSql, [
    liveSessionId, userId, officeId, completionPurgeKey, "case", "POST", proofFingerprint,
    makeApiProof({ action:"lookup", sessionId:liveSessionId, key:completionPurgeKey, resourceType:"case", operation:"POST", fingerprint:proofFingerprint })
  ]);
  assert.equal(completionPurgeTombstone.rows[0].response_status, 201);
  assert.equal(completionPurgeTombstone.rows[0].response_body_purged, true);
  assert.ok(completionPurgeTombstone.rows[0].purged_at);

  // A valid completion-proof replay racing with cleanup must remain a no-op;
  // cleanup may hold the tombstone row without granting replay a rewrite path.
  const purgeFirstKey = "runtime-proof-purge-first-001";
  const purgeFirstReservation = await runtimePool.query(reserveSql, reserveArgs(
    liveSessionId, userId, purgeFirstKey, makeReserveProof(liveSessionId, userId, purgeFirstKey)
  ));
  assert.equal(purgeFirstReservation.rows[0].inserted, true);
  const initialCompletion = await runtimePool.query(completeSql, [
    liveSessionId, userId, officeId, purgeFirstKey, "case", "POST",
    proofFingerprint, caseId, 201,
    makeCompleteProof(liveSessionId, userId, purgeFirstKey, caseId, 201)
  ]);
  assert.equal(initialCompletion.rows[0].completed, true);
  const cleanupFirstClient = await pool.connect();
  const completionWaitingClient = await runtimePool.connect();
  try {
    await cleanupFirstClient.query("BEGIN");
    await cleanupFirstClient.query(
      "UPDATE public.api_mutation_idempotency SET response_body=NULL,response_body_purged=true,purged_at=clock_timestamp() WHERE office_id=$1 AND user_id=$2 AND idempotency_key=$3 AND completed_at IS NOT NULL",
      [officeId, userId, purgeFirstKey]
    );
    await completionWaitingClient.query("BEGIN");
    await completionWaitingClient.query("SET LOCAL lock_timeout = '3s'");
    let completionSettled = false;
    const completionPromise = completionWaitingClient.query(completeSql, [
      liveSessionId, userId, officeId, purgeFirstKey, "case", "POST",
      proofFingerprint, caseId, 201,
      makeCompleteProof(liveSessionId, userId, purgeFirstKey, caseId, 201)
    ]).then(value => { completionSettled = true; return { value }; }, error => { completionSettled = true; return { error }; });
    await delay(100);
    assert.equal(completionSettled, true, "completion replay should be a no-op because response_status is already non-NULL");
    await cleanupFirstClient.query("COMMIT");
    const completionOutcome = await completionPromise;
    assert.equal(completionOutcome.error, undefined, "completion replay should resolve after cleanup commits");
    assert.equal(completionOutcome.value.rows[0].completed, false, "a valid completion proof must not rewrite an already-completed tombstone");
    await completionWaitingClient.query("COMMIT");
  } finally {
    await cleanupFirstClient.query("ROLLBACK").catch(() => {});
    await completionWaitingClient.query("ROLLBACK").catch(() => {});
    cleanupFirstClient.release();
    completionWaitingClient.release();
  }
  const purgeFirstRow = await pool.query(
    "SELECT response_status,response_body_purged,purged_at,response_body FROM public.api_mutation_idempotency WHERE office_id=$1 AND user_id=$2 AND idempotency_key=$3",
    [officeId, userId, purgeFirstKey]
  );
  assert.equal(purgeFirstRow.rowCount, 1, "cleanup must retain the key tombstone");
  assert.equal(purgeFirstRow.rows[0].response_status, 201);
  assert.equal(purgeFirstRow.rows[0].response_body_purged, true);
  assert.ok(purgeFirstRow.rows[0].purged_at);
  assert.equal(purgeFirstRow.rows[0].response_body, null);
  console.log("PASS: valid-proof replay is identity-bound; completion and response-body cleanup serialize without reopening tombstones");

  const revokedSession = (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at,revoked_at) VALUES($1,$2,$3,$4,now()+interval '1 hour',now()) RETURNING id",
    [userId,officeId,hash("revoked-proof-token"),hash("revoked-proof-csrf")]
  )).rows[0].id;
  const revokedKey = "runtime-proof-revoked-001";
  await assert.rejects(runtimePool.query(reserveSql, reserveArgs(revokedSession,userId,revokedKey,makeReserveProof(revokedSession,userId,revokedKey))), error => error.code === "28000", "revoked session must fail");
  await assert.rejects(
    runtimePool.query(lookupSql, [
      revokedSession, userId, officeId, "runtime-proof-revoked-001", "case", "POST", proofFingerprint,
      makeApiProof({ action:"lookup", sessionId:revokedSession, key:"runtime-proof-revoked-001", resourceType:"case", operation:"POST", fingerprint:proofFingerprint })
    ]),
    error => error.code === "28000",
    "revoked session must not read or replay an idempotency result"
  );
  await assert.rejects(
    runtimePool.query(completeSql, [
      revokedSession, userId, officeId, "runtime-proof-revoked-001", "case", "POST", proofFingerprint, caseId, 201,
      makeCompleteProof(revokedSession, userId, "runtime-proof-revoked-001", caseId, 201)
    ]),
    error => error.code === "28000",
    "revoked session must not complete an idempotency reservation"
  );
  const expiredSession = (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()-interval '1 minute') RETURNING id",
    [userId,officeId,hash("expired-proof-token"),hash("expired-proof-csrf")]
  )).rows[0].id;
  const expiredKey = "runtime-proof-expired-001";
  await assert.rejects(runtimePool.query(reserveSql, reserveArgs(expiredSession,userId,expiredKey,makeReserveProof(expiredSession,userId,expiredKey))), error => error.code === "28000", "expired session must fail");
  const newLoginSession = (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') RETURNING id",
    [userId,officeId,hash("new-login-proof-token"),hash("new-login-proof-csrf")]
  )).rows[0].id;
  const oldLoginKey = "runtime-proof-old-login-001";
  await assert.rejects(runtimePool.query(reserveSql, reserveArgs(revokedSession,userId,oldLoginKey,makeReserveProof(revokedSession,userId,oldLoginKey))), error => error.code === "28000", "old session proof must remain invalid after re-login");
  const newLoginKey = "runtime-proof-new-login-001";
  const newLoginReservation = await runtimePool.query(reserveSql, reserveArgs(newLoginSession,userId,newLoginKey,makeReserveProof(newLoginSession,userId,newLoginKey)));
  assert.equal(newLoginReservation.rows[0].inserted, true, "new live session proof should work");
  await pool.query("INSERT INTO users(id,office_id,full_name,email,role) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccc04',$1,'Other Runtime User','runtime-other@example.test','owner')", [officeId]);
  const otherUserSession = (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccc04',$1,$2,$3,now()+interval '1 hour') RETURNING id",
    [officeId,hash("other-user-proof-token"),hash("other-user-proof-csrf")]
  )).rows[0].id;
  const crossUserKey = "runtime-proof-cross-user-001";
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(otherUserSession,userId,crossUserKey,makeReserveProof(otherUserSession,userId,crossUserKey))),
    error => error.code === "28000",
    "session belonging to another user must fail"
  );

  // Session liveness also depends on the current user state, not only the session row.
  const inactiveUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccc05";
  await pool.query(
    "INSERT INTO users(id,office_id,full_name,email,role,is_active) VALUES($1,$2,'Inactive Runtime User','runtime-inactive@example.test','owner',false)",
    [inactiveUserId,officeId]
  );
  const inactiveSessionId = (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') RETURNING id",
    [inactiveUserId,officeId,hash("inactive-user-token"),hash("inactive-user-csrf")]
  )).rows[0].id;
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(
      inactiveSessionId,inactiveUserId,"runtime-proof-inactive-user-001",
      makeReserveProof(inactiveSessionId,inactiveUserId,"runtime-proof-inactive-user-001")
    )),
    error => error.code === "28000",
    "an active session belonging to a disabled user must not reserve an idempotency key"
  );

  const deletedUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccc06";
  await pool.query(
    "INSERT INTO users(id,office_id,full_name,email,role,deleted_at) VALUES($1,$2,'Deleted Runtime User','runtime-deleted@example.test','owner',clock_timestamp())",
    [deletedUserId,officeId]
  );
  const deletedSessionId = (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') RETURNING id",
    [deletedUserId,officeId,hash("deleted-user-token"),hash("deleted-user-csrf")]
  )).rows[0].id;
  await assert.rejects(
    runtimePool.query(reserveSql, reserveArgs(
      deletedSessionId,deletedUserId,"runtime-proof-deleted-user-001",
      makeReserveProof(deletedSessionId,deletedUserId,"runtime-proof-deleted-user-001")
    )),
    error => error.code === "28000",
    "an active session belonging to a soft-deleted user must not reserve an idempotency key"
  );

  // If user deactivation commits while a reservation waits for the user lock,
  // the proof function must re-read user state and fail closed.
  const deactivateRaceUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccc07";
  await pool.query(
    "INSERT INTO users(id,office_id,full_name,email,role) VALUES($1,$2,'Deactivation Race User','runtime-deactivate-race@example.test','owner')",
    [deactivateRaceUserId,officeId]
  );
  const deactivateRaceSessionId = (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') RETURNING id",
    [deactivateRaceUserId,officeId,hash("deactivation-race-token"),hash("deactivation-race-csrf")]
  )).rows[0].id;
  const deactivatingClient = await pool.connect();
  const waitingReservationClient = await runtimePool.connect();
  try {
    await deactivatingClient.query("BEGIN");
    await deactivatingClient.query("UPDATE users SET is_active=false WHERE id=$1", [deactivateRaceUserId]);
    await waitingReservationClient.query("BEGIN");
    await waitingReservationClient.query("SET LOCAL lock_timeout = '3s'");
    let deactivationRaceSettled = false;
    const deactivationRacePromise = waitingReservationClient.query(reserveSql, reserveArgs(
      deactivateRaceSessionId,deactivateRaceUserId,"runtime-proof-deactivate-race-001",
      makeReserveProof(deactivateRaceSessionId,deactivateRaceUserId,"runtime-proof-deactivate-race-001")
    )).then(
      value => { deactivationRaceSettled = true; return { value }; },
      error => { deactivationRaceSettled = true; return { error }; }
    );
    await delay(100);
    assert.equal(deactivationRaceSettled, false, "reservation must wait for an in-flight user deactivation lock");
    await deactivatingClient.query("COMMIT");
    const deactivationRace = await deactivationRacePromise;
    assert.equal(deactivationRace.error?.code, "28000", "reservation must fail after user deactivation commits");
    await waitingReservationClient.query("ROLLBACK");
  } finally {
    await deactivatingClient.query("ROLLBACK").catch(() => {});
    await waitingReservationClient.query("ROLLBACK").catch(() => {});
    deactivatingClient.release();
    waitingReservationClient.release();
  }
  console.log("PASS: disabled/deleted users and deactivation-first races cannot use otherwise-live session proofs");

  console.log("PASS: revoked, expired, old-login, and cross-user session proofs are rejected");

  const makeLiveSession = async label => (await pool.query(
    "INSERT INTO auth_sessions(user_id,office_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour') RETURNING id",
    [userId,officeId,hash(label + "-token"),hash(label + "-csrf")]
  )).rows[0].id;

  // If a mutation wins the session-row lock, logout must wait until the whole
  // business/audit/idempotency transaction completes. The test uses only this
  // disposable PostgreSQL database and a bounded lock_timeout.
  const mutationFirstSession = await makeLiveSession("mutation-first-race");
  const mutationFirstKey = "runtime-proof-mutation-first-001";
  const mutationFirstClient = await runtimePool.connect();
  const logoutWaitingClient = await pool.connect();
  try {
    await mutationFirstClient.query("BEGIN");
    const reserved = await mutationFirstClient.query(reserveSql, reserveArgs(
      mutationFirstSession, userId, mutationFirstKey,
      makeReserveProof(mutationFirstSession, userId, mutationFirstKey)
    ));
    assert.equal(reserved.rows[0].inserted, true);
    await logoutWaitingClient.query("BEGIN");
    await logoutWaitingClient.query("SET LOCAL lock_timeout = '150ms'");
    await assert.rejects(
      logoutWaitingClient.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [mutationFirstSession]),
      error => error.code === "55P03",
      "logout must block while the mutation owns the session lock"
    );
    await logoutWaitingClient.query("ROLLBACK");
    const completedRace = await mutationFirstClient.query(completeSql, [
      mutationFirstSession, userId, officeId, mutationFirstKey, "case", "POST",
      proofFingerprint, caseId, 201,
      makeCompleteProof(mutationFirstSession, userId, mutationFirstKey, caseId, 201)
    ]);
    assert.equal(completedRace.rows[0].completed, true);
    await mutationFirstClient.query("COMMIT");
    await pool.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [mutationFirstSession]);
    await assert.rejects(
      runtimePool.query(reserveSql, reserveArgs(
        mutationFirstSession, userId, "runtime-proof-after-logout-001",
        makeReserveProof(mutationFirstSession, userId, "runtime-proof-after-logout-001")
      )),
      error => error.code === "28000",
      "a mutation after committed logout must fail"
    );
  } finally {
    await mutationFirstClient.query("ROLLBACK").catch(() => {});
    await logoutWaitingClient.query("ROLLBACK").catch(() => {});
    mutationFirstClient.release();
    logoutWaitingClient.release();
  }
  console.log("PASS: logout cannot revoke a session mid-mutation; after logout commits, new reservations are rejected");

  // If logout acquires the session row first, a concurrent reservation must
  // wait, observe the committed revocation, and fail rather than sneak through.
  const logoutFirstSession = await makeLiveSession("logout-first-race");
  const logoutFirstClient = await pool.connect();
  const mutationWaitingClient = await runtimePool.connect();
  try {
    await logoutFirstClient.query("BEGIN");
    await logoutFirstClient.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [logoutFirstSession]);
    await mutationWaitingClient.query("BEGIN");
    await mutationWaitingClient.query("SET LOCAL lock_timeout = '3s'");
    let reserveSettled = false;
    const waitingReservation = mutationWaitingClient.query(reserveSql, reserveArgs(
      logoutFirstSession, userId, "runtime-proof-logout-first-001",
      makeReserveProof(logoutFirstSession, userId, "runtime-proof-logout-first-001")
    )).then(
      value => { reserveSettled = true; return { value }; },
      error => { reserveSettled = true; return { error }; }
    );
    await delay(100);
    assert.equal(reserveSettled, false, "reservation should wait for the in-flight logout row lock");
    await logoutFirstClient.query("COMMIT");
    const reserveOutcome = await waitingReservation;
    assert.equal(reserveOutcome.error?.code, "28000", "reservation must reject after logout commits");
    await mutationWaitingClient.query("ROLLBACK");
  } finally {
    await logoutFirstClient.query("ROLLBACK").catch(() => {});
    await mutationWaitingClient.query("ROLLBACK").catch(() => {});
    logoutFirstClient.release();
    mutationWaitingClient.release();
  }
  console.log("PASS: logout-first race serializes; waiting reservation observes revocation and fails");

  // Two different keys for one actor must acquire session/user locks in the
  // same order and serialize without deadlock.
  const lockOrderSession = await makeLiveSession("lock-order-race");
  const lockOrderClientA = await runtimePool.connect();
  const lockOrderClientB = await runtimePool.connect();
  try {
    await lockOrderClientA.query("BEGIN");
    const keyA = "runtime-proof-lock-order-a1";
    const keyB = "runtime-proof-lock-order-b1";
    const firstLock = await lockOrderClientA.query(reserveSql, reserveArgs(
      lockOrderSession, userId, keyA, makeReserveProof(lockOrderSession, userId, keyA)
    ));
    assert.equal(firstLock.rows[0].inserted, true);
    await lockOrderClientB.query("BEGIN");
    await lockOrderClientB.query("SET LOCAL lock_timeout = '3s'");
    let secondSettled = false;
    const secondLockPromise = lockOrderClientB.query(reserveSql, reserveArgs(
      lockOrderSession, userId, keyB, makeReserveProof(lockOrderSession, userId, keyB)
    )).then(
      value => { secondSettled = true; return { value }; },
      error => { secondSettled = true; return { error }; }
    );
    await delay(100);
    assert.equal(secondSettled, false, "second mutation should serialize behind the first session lock");
    await lockOrderClientA.query(completeSql, [
      lockOrderSession, userId, officeId, keyA, "case", "POST", proofFingerprint, caseId, 201,
      makeCompleteProof(lockOrderSession, userId, keyA, caseId, 201)
    ]);
    await lockOrderClientA.query("COMMIT");
    const secondLock = await secondLockPromise;
    assert.equal(secondLock.error, undefined, "second mutation must continue after first commit, without deadlock");
    assert.equal(secondLock.value.rows[0].inserted, true);
    await lockOrderClientB.query(completeSql, [
      lockOrderSession, userId, officeId, keyB, "case", "POST", proofFingerprint, caseId, 201,
      makeCompleteProof(lockOrderSession, userId, keyB, caseId, 201)
    ]);
    await lockOrderClientB.query("COMMIT");
  } finally {
    await lockOrderClientA.query("ROLLBACK").catch(() => {});
    await lockOrderClientB.query("ROLLBACK").catch(() => {});
    lockOrderClientA.release();
    lockOrderClientB.release();
  }
  console.log("PASS: concurrent mutations for one session serialize in session-then-user lock order without deadlock");

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
      has_column_privilege('dadban_document_runtime_ci','public.case_documents','office_id','UPDATE') AS can_update_document_office,
      has_column_privilege('dadban_document_runtime_ci','public.case_documents','case_id','UPDATE') AS can_update_document_case,
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
      has_column_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','purged_at','UPDATE') AS can_update_api_purged_at,
      has_column_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','response_body_purged','SELECT') AS can_select_api_purged_flag,
      has_column_privilege('dadban_document_runtime_ci','public.api_mutation_idempotency','purged_at','SELECT') AS can_select_api_purged_at,
      (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member WHERE member_role.rolname='dadban_document_runtime_ci') AS direct_membership_count
    FROM pg_roles r WHERE r.rolname='dadban_document_runtime_ci'
  `);
  const role = roleState.rows[0];
  for (const attr of ["rolsuper","rolcreatedb","rolcreaterole","rolinherit","member_schema_owner","member_migrator","can_update_users","can_update_full_name","can_update_user_role","can_update_user_active","can_update_user_deleted","can_update_clients","can_update_cases","can_update_client_deleted","can_update_case_deleted","can_update_document_office","can_update_document_case","can_read_audit","can_update_audit","can_delete_audit","can_delete_idem","can_truncate_idem","can_update_purged_at","can_update_api_idem_table","can_delete_api_idem","can_truncate_api_idem","can_manage_api_idem_triggers","can_update_api_purged_flag","can_update_api_purged_at"]) {
    assert.equal(role[attr], false, `runtime role must not have ${attr}`);
  }
  assert.notEqual(role.idem_owner, "dadban_document_runtime_ci", "runtime must not own the idempotency table");
  assert.notEqual(role.api_idem_owner, "dadban_document_runtime_ci", "runtime must not own the generic API idempotency table");
  assert.equal(role.direct_membership_count, 0, "runtime must not have memberships that permit SET ROLE to an elevated role");
  assert.equal(role.can_complete_api_idem, false, "runtime must not directly update generic idempotency result columns");
  assert.equal((await pool.query("SELECT has_table_privilege($1, 'public.api_mutation_idempotency', 'INSERT') AS can_insert", ["dadban_document_runtime_ci"])).rows[0].can_insert, false, "runtime must not directly insert generic idempotency reservations");
  assert.equal((await pool.query("SELECT has_function_privilege($1, 'public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)', 'EXECUTE') AS can_reserve", ["dadban_document_runtime_ci"])).rows[0].can_reserve, true, "runtime needs reserve function EXECUTE");
  assert.equal((await pool.query("SELECT has_function_privilege($1, 'public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)', 'EXECUTE') AS can_read", ["dadban_document_runtime_ci"])).rows[0].can_read, true, "runtime needs proof-bound lookup function EXECUTE");
  assert.equal((await pool.query("SELECT has_function_privilege($1, 'public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)', 'EXECUTE') AS can_complete", ["dadban_document_runtime_ci"])).rows[0].can_complete, true, "runtime needs complete function EXECUTE");
  assert.equal(role.can_select_api_purged_flag, false, "runtime must not directly read the tombstone marker");
  assert.equal(role.can_select_api_purged_at, false, "runtime must not directly read the purge timestamp");
  const alternateRuntimePrivileges = await pool.query("SELECT has_table_privilege($1,'public.api_mutation_idempotency','SELECT') AS can_select, has_table_privilege($1,'public.api_mutation_idempotency','INSERT') AS can_insert, has_table_privilege($1,'public.api_mutation_idempotency','UPDATE') AS can_update, has_table_privilege($1,'public.api_mutation_idempotency','DELETE') AS can_delete, has_table_privilege($1,'public.api_mutation_idempotency','TRUNCATE') AS can_truncate", ["dadban_document_runtime_alt_ci"]);
  assert.deepEqual(alternateRuntimePrivileges.rows[0], { can_select:false, can_insert:false, can_update:false, can_delete:false, can_truncate:false }, "a differently named runtime role must fail closed until explicitly granted equivalent privileges");
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
  const apiProofFunctions = await pool.query(`
    SELECT p.proname, pg_get_userbyid(p.proowner) AS function_owner,
      p.prosecdef AS security_definer, p.proconfig,
      owner.rolsuper AS owner_superuser, owner.rolcanlogin AS owner_can_login,
      owner.rolcreatedb AS owner_createdb, owner.rolcreaterole AS owner_createrole,
      owner.rolinherit AS owner_inherit,
       has_schema_privilege('dadban_api_idempotency_owner','public','CREATE') AS owner_create_public,
      has_function_privilege('dadban_document_runtime_ci',p.oid,'EXECUTE') AS runtime_execute,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member
        WHERE r.rolname='dadban_api_idempotency_owner') AS owner_membership_count
    FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
    WHERE p.oid IN (
      'public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,
      'public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,
      'public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)'::regprocedure
    )
    ORDER BY p.proname
  `);
  assert.equal(apiProofFunctions.rowCount, 3, "all proof-bound API idempotency functions must exist");
  for (const fn of apiProofFunctions.rows) {
    assert.equal(fn.function_owner, "dadban_api_idempotency_owner");
    assert.equal(fn.security_definer, true);
    assert.deepEqual(fn.proconfig, ["search_path=pg_catalog, pg_temp"]);
    assert.equal(fn.owner_superuser, false);
    assert.equal(fn.owner_can_login, false);
    assert.equal(fn.owner_createdb, false);
    assert.equal(fn.owner_createrole, false);
    assert.equal(fn.owner_inherit, false);
     assert.equal(fn.owner_create_public, false, "function owner must not retain CREATE on public");
    assert.equal(fn.owner_membership_count, 0);
    assert.equal(fn.runtime_execute, true);
    assert.equal(fn.public_execute, false);
  }
  console.log("PASS: proof functions use a non-login least-privilege owner and are not executable by PUBLIC");

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
    env: { ...process.env, PORT: String(port), NODE_ENV: "test", DATABASE_URL: apiDatabaseUrl, CORS_ORIGIN: origin, RATE_LIMIT_MODE: "memory", API_MUTATION_IDEMPOTENCY_HMAC_KEY: proofSecret },
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
  await denied("DELETE FROM public.api_mutation_idempotency", "DELETE generic idempotency identity");
  await denied("INSERT INTO public.api_mutation_idempotency (office_id,user_id,idempotency_key,resource_type,operation,request_fingerprint,response_status,response_body,completed_at,response_body_purged,purged_at) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,'cccccccc-cccc-4ccc-8ccc-cccccccccc01'::uuid,'forged-complete-01','client','POST',repeat('a',64),201,'{}'::jsonb,clock_timestamp(),true,clock_timestamp())", "insert pre-completed generic idempotency tombstone");
  await denied("UPDATE public.api_mutation_idempotency SET response_body_purged=false", "UPDATE generic tombstone marker");
  await denied("TRUNCATE public.api_mutation_idempotency", "TRUNCATE generic idempotency table");
  await denied("ALTER TABLE public.api_mutation_idempotency DISABLE TRIGGER ALL", "disable generic tombstone triggers");

  const counts = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM case_documents WHERE id=$3) AS business_rows,
      (SELECT count(*)::int FROM case_document_mutation_idempotency WHERE office_id=$1 AND user_id=$2) AS idempotency_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3) AS audit_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3 AND action='create') AS create_audit_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3 AND action='update') AS update_audit_rows,
      (SELECT count(*)::int FROM audit_logs WHERE office_id=$1 AND entity_type='case_document' AND entity_id=$3 AND action='delete') AS delete_audit_rows,
      (SELECT count(*)::int FROM case_documents WHERE id=$3 AND deleted_at IS NOT NULL) AS soft_deleted_documents
  `, [officeId,userId,documentId]);
  assert.deepEqual(counts.rows[0], {
    business_rows:1, idempotency_rows:3, audit_rows:4, create_audit_rows:1, update_audit_rows:2, delete_audit_rows:1, soft_deleted_documents:1
  });
  const durableKeys = await pool.query(
    "SELECT idempotency_key,response_status,purged_at FROM case_document_mutation_idempotency WHERE office_id=$1 AND user_id=$2 ORDER BY idempotency_key",
    [officeId,userId]
  );
  assert.equal(durableKeys.rowCount, 3);
  assert.deepEqual(durableKeys.rows.map(row=>row.response_status).sort((a,b)=>a-b), [200,200,204]);
  assert.ok(durableKeys.rows.every(row=>row.purged_at === null));
  console.log(`DIRECT DB ASSERTIONS: business_rows=${counts.rows[0].business_rows} case_document_mutation_idempotency=${counts.rows[0].idempotency_rows} audit_logs=${counts.rows[0].audit_rows} create=${counts.rows[0].create_audit_rows} update=${counts.rows[0].update_audit_rows} delete=${counts.rows[0].delete_audit_rows} soft_deleted=${counts.rows[0].soft_deleted_documents}`);
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
  // These roles are cluster-wide objects. Destructive cleanup is gated
  // by the preflight proving the test-only role names were initially absent.
  if (testRoleCleanupAuthorized) try {
    await pool.query(`
      DO $cleanup$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_owner_ci')
           AND to_regclass('public.case_documents') IS NOT NULL
           AND (SELECT c.relowner FROM pg_class c WHERE c.oid='public.case_documents'::regclass)
               = (SELECT oid FROM pg_roles WHERE rolname='dadban_case_documents_owner_ci') THEN
          ALTER TABLE public.case_documents OWNER TO postgres;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_owner_ci')
           AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_migrator_ci') THEN
          REVOKE dadban_case_documents_owner_ci FROM dadban_case_documents_migrator_ci;
        END IF;
      END
      $cleanup$
    `);
    await pool.query(`
      DO $cleanup$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_migrator_ci') THEN
          EXECUTE 'DROP OWNED BY dadban_case_documents_migrator_ci';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_owner_ci') THEN
          EXECUTE 'DROP OWNED BY dadban_case_documents_owner_ci';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_alt_ci') THEN
          EXECUTE 'DROP OWNED BY dadban_document_runtime_alt_ci';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_alt_ci') THEN
          EXECUTE 'DROP ROLE dadban_document_runtime_alt_ci';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_migrator_ci') THEN
          EXECUTE 'DROP ROLE dadban_case_documents_migrator_ci';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_case_documents_owner_ci') THEN
          EXECUTE 'DROP ROLE dadban_case_documents_owner_ci';
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_ci') THEN
          EXECUTE 'ALTER ROLE dadban_document_runtime_ci NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
        END IF;
      END
      $cleanup$
    `);
    const leftoverRoles = await pool.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('dadban_document_runtime_alt_ci','dadban_case_documents_owner_ci','dadban_case_documents_migrator_ci')"
    );
    assert.equal(leftoverRoles.rowCount, 0, "runtime-alt/owner/migrator roles created in this database must not leak into the CI PostgreSQL cluster");
    const restoredRuntimeRole = await pool.query(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='dadban_document_runtime_ci'"
    );
    assert.equal(restoredRuntimeRole.rowCount, 1, "shared runtime role created by the earlier tombstone step must remain present");
    assert.deepEqual(restoredRuntimeRole.rows[0], { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
      "shared runtime role must be restored to the earlier NOLOGIN least-privilege state");
    console.log("PASS: owner/migrator/runtime-alt roles are removed; shared runtime role is restored to NOLOGIN with no elevated privileges");
  } catch (cleanupError) {
    console.error("FAIL: isolated owner/migrator cleanup did not complete", cleanupError);
    process.exitCode = 1;
  }
  await runtimePool.end();
  await pool.end();
}
