import pg from "pg";

const { Pool } = pg;
const adminUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.RUNTIME_DATABASE_URL;
if (!adminUrl || !runtimeUrl) throw new Error("DATABASE_URL and RUNTIME_DATABASE_URL are required");
const adminParsed = new URL(adminUrl);
const runtimeParsed = new URL(runtimeUrl);
if (!["localhost", "127.0.0.1"].includes(adminParsed.hostname) ||
    !["localhost", "127.0.0.1"].includes(runtimeParsed.hostname) ||
    adminParsed.pathname !== "/dadban_actor_lock_definer_test" ||
    runtimeParsed.pathname !== "/dadban_actor_lock_definer_test" ||
    runtimeParsed.username !== "dadban_actor_runtime_ci") {
  throw new Error("Actor-lock role test may only use the dedicated localhost /dadban_actor_lock_definer_test database and expected runtime login");
}

const admin = new Pool({ connectionString: adminUrl, max: 6 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 3 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const officeId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const sessionId = "30000000-0000-4000-8000-000000000001";
let roleCleanupAuthorized = false;

async function waitForLockWait(applicationName) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await admin.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE application_name=$1",
      [applicationName]
    );
    if (result.rows.some(row => row.wait_event_type === "Lock")) return;
    await sleep(20);
  }
  throw new Error(`Concurrent mutation did not wait on actor row locks: ${applicationName}`);
}

async function setup() {
  const existingRoles = await admin.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('dadban_actor_runtime_ci','dadban_actor_lock_owner_ci')"
  );
  assert(existingRoles.rowCount === 0,
    "Refusing to reuse pre-existing actor-lock CI roles; inspect prior test cleanup");
  // Cleanup may drop these names only after proving this test starts without them.
  roleCleanupAuthorized = true;

  await admin.query(`
    DROP SCHEMA IF EXISTS actor_lock_test CASCADE;
    DO $role_guard$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('dadban_actor_runtime_ci','dadban_actor_lock_owner_ci')) THEN
        RAISE EXCEPTION 'Refusing to reuse pre-existing actor-lock CI roles; inspect prior test cleanup';
      END IF;
    END;
    $role_guard$;
    CREATE ROLE dadban_actor_lock_owner_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    CREATE ROLE dadban_actor_runtime_ci LOGIN PASSWORD 'ci-only-actor-runtime-password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    CREATE SCHEMA actor_lock_test;
    REVOKE ALL ON SCHEMA actor_lock_test FROM PUBLIC;
    GRANT USAGE ON SCHEMA actor_lock_test TO dadban_actor_lock_owner_ci, dadban_actor_runtime_ci;
    CREATE TABLE actor_lock_test.users (
      id uuid PRIMARY KEY, office_id uuid NOT NULL, role text NOT NULL,
      full_name text NOT NULL DEFAULT 'Synthetic Actor',
      is_active boolean NOT NULL DEFAULT true, deleted_at timestamptz
    );
    CREATE TABLE actor_lock_test.auth_sessions (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES actor_lock_test.users(id),
      office_id uuid NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
    );
    INSERT INTO actor_lock_test.users(id,office_id,role,is_active)
      VALUES ('${userId}','${officeId}','owner',true);
    INSERT INTO actor_lock_test.auth_sessions(id,user_id,office_id,expires_at)
      VALUES ('${sessionId}','${userId}','${officeId}',clock_timestamp()+interval '1 hour');
    GRANT SELECT ON actor_lock_test.users, actor_lock_test.auth_sessions TO dadban_actor_lock_owner_ci;
    -- PostgreSQL requires UPDATE privilege on each FOR UPDATE target; these narrow grants
    -- belong only to the NOLOGIN function owner, never to the API runtime role.
    GRANT UPDATE (full_name) ON actor_lock_test.users TO dadban_actor_lock_owner_ci;
  `);

  await admin.query("GRANT UPDATE (revoked_at) ON actor_lock_test.auth_sessions TO dadban_actor_lock_owner_ci");
  await admin.query(`
    CREATE FUNCTION actor_lock_test.lock_live_actor(p_session uuid, p_user uuid, p_office uuid)
    RETURNS TABLE(valid boolean, actor_role text)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE locked_role text; is_live boolean;
    BEGIN
      SELECT u.role INTO locked_role
      FROM actor_lock_test.auth_sessions AS s
      JOIN actor_lock_test.users AS u ON u.id=s.user_id AND u.office_id=s.office_id
      WHERE s.id=p_session AND s.user_id=p_user AND s.office_id=p_office
      FOR UPDATE OF s,u;
      IF NOT FOUND THEN
        RETURN QUERY SELECT false, NULL::text;
        RETURN;
      END IF;
      SELECT (s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
              AND u.is_active AND u.deleted_at IS NULL), u.role
        INTO is_live, locked_role
      FROM actor_lock_test.auth_sessions AS s
      JOIN actor_lock_test.users AS u ON u.id=s.user_id AND u.office_id=s.office_id
      WHERE s.id=p_session AND s.user_id=p_user AND s.office_id=p_office;
      RETURN QUERY SELECT coalesce(is_live,false), locked_role;
    END
    $function$;
    ALTER FUNCTION actor_lock_test.lock_live_actor(uuid,uuid,uuid) OWNER TO dadban_actor_lock_owner_ci;
    REVOKE ALL ON FUNCTION actor_lock_test.lock_live_actor(uuid,uuid,uuid) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION actor_lock_test.lock_live_actor(uuid,uuid,uuid) TO dadban_actor_runtime_ci;
    GRANT CONNECT ON DATABASE dadban_actor_lock_definer_test TO dadban_actor_runtime_ci;
    REVOKE ALL ON actor_lock_test.users, actor_lock_test.auth_sessions FROM dadban_actor_runtime_ci;
  `);

  const proof = await admin.query(`
    SELECT r.rolsuper, r.rolcanlogin,
      pg_get_userbyid(p.proowner) AS function_owner,
      p.prosecdef AS security_definer,
      p.proconfig,
      has_table_privilege('dadban_actor_runtime_ci','actor_lock_test.users','UPDATE') AS runtime_update_users,
      has_column_privilege('dadban_actor_runtime_ci','actor_lock_test.users','full_name','UPDATE') AS runtime_update_full_name,
      has_table_privilege('dadban_actor_runtime_ci','actor_lock_test.users','SELECT') AS runtime_select_users,
      has_function_privilege('dadban_actor_runtime_ci','actor_lock_test.lock_live_actor(uuid,uuid,uuid)','EXECUTE') AS runtime_execute
    FROM pg_roles r
    CROSS JOIN pg_proc p
    WHERE r.rolname='dadban_actor_lock_owner_ci'
      AND p.oid='actor_lock_test.lock_live_actor(uuid,uuid,uuid)'::regprocedure
  `);
  const row = proof.rows[0];
  assert(row && row.rolsuper === false && row.rolcanlogin === false, "Function owner must be NOLOGIN NOSUPERUSER");
  assert(row.function_owner === "dadban_actor_lock_owner_ci" && row.security_definer, "Function owner/security-definer catalog proof failed");
  assert(JSON.stringify(row.proconfig) === JSON.stringify(["search_path=pg_catalog, pg_temp"]), "Function search_path must exclude writable application schemas");
  assert(row.runtime_update_users === false && row.runtime_update_full_name === false && row.runtime_select_users === false && row.runtime_execute === true,
    "Runtime role must have EXECUTE only, with no direct users table access");
  console.log("CATALOG ASSERTIONS:", JSON.stringify(row));
}

async function resetActor() {
  await admin.query("UPDATE actor_lock_test.users SET role='owner',is_active=true,deleted_at=NULL WHERE id=$1", [userId]);
  await admin.query("UPDATE actor_lock_test.auth_sessions SET revoked_at=NULL,expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [sessionId]);
}

async function raceMutation(label, sql, expected) {
  await resetActor();
  const locker = await runtime.connect();
  const mutator = await admin.connect();
  const applicationName = `actor-lock-${label}`;
  try {
    await locker.query("BEGIN");
    const initial = await locker.query(
      "SELECT * FROM actor_lock_test.lock_live_actor($1,$2,$3)",
      [sessionId,userId,officeId]
    );
    assert(initial.rows[0]?.valid === true && initial.rows[0]?.actor_role === "owner", `${label}: initial actor authorization failed`);
    await mutator.query("SELECT set_config('application_name',$1,false)", [applicationName]);
    const mutation = mutator.query(sql, [sessionId,userId]);
    await waitForLockWait(applicationName);
    await locker.query("COMMIT");
    await mutation;
    const after = await runtime.query(
      "SELECT * FROM actor_lock_test.lock_live_actor($1,$2,$3)",
      [sessionId,userId,officeId]
    );
    assert(after.rows[0]?.valid === expected.valid, `${label}: validity mismatch: ${JSON.stringify(after.rows[0])}`);
    assert(after.rows[0]?.actor_role === expected.role, `${label}: role mismatch: ${JSON.stringify(after.rows[0])}`);
    const counts = await admin.query(`
      SELECT (SELECT count(*)::int FROM actor_lock_test.users WHERE id=$1) AS users,
             (SELECT count(*)::int FROM actor_lock_test.auth_sessions WHERE id=$2) AS sessions,
             (SELECT count(*)::int FROM actor_lock_test.auth_sessions WHERE id=$2 AND revoked_at IS NOT NULL) AS revoked_sessions,
             (SELECT count(*)::int FROM actor_lock_test.users WHERE id=$1 AND is_active=false) AS inactive_users,
             (SELECT role FROM actor_lock_test.users WHERE id=$1) AS persisted_role
    `, [userId,sessionId]);
    console.log(`DIRECT DB ASSERTION [${label}]:`, JSON.stringify(counts.rows[0]));
    console.log(`PASS: SECURITY DEFINER serializes ${label}; next authorization observes committed state`);
  } finally {
    try { await locker.query("ROLLBACK"); } catch {}
    mutator.release();
    locker.release();
  }
}

try {
  await setup();
  await raceMutation(
    "session revocation",
    "UPDATE actor_lock_test.auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1 AND user_id=$2",
    { valid: false, role: "owner" }
  );
  await raceMutation(
    "role change",
    "UPDATE actor_lock_test.users SET role='viewer' WHERE id=$2 AND $1::uuid IS NOT NULL",
    { valid: true, role: "viewer" }
  );
  await raceMutation(
    "user deactivation",
    "UPDATE actor_lock_test.users SET is_active=false WHERE id=$2 AND $1::uuid IS NOT NULL",
    { valid: false, role: "owner" }
  );
  // Force a real privilege error inside SECURITY DEFINER, then prove the
  // caller can roll back the failed transaction and use the helper after repair.
  await resetActor();
  await admin.query("REVOKE SELECT ON actor_lock_test.users FROM dadban_actor_lock_owner_ci");
  const failingClient = await runtime.connect();
  try {
    await failingClient.query("BEGIN");
    const failure = await failingClient.query(
      "SELECT * FROM actor_lock_test.lock_live_actor($1,$2,$3)",
      [sessionId,userId,officeId]
    ).then(() => null, error => error);
    assert(failure && failure.code === "42501", `Expected SQLSTATE 42501 from revoked owner privilege, got ${failure?.code || "no error"}`);
    await failingClient.query("ROLLBACK");
    console.log("PASS: SECURITY DEFINER privilege error returns SQLSTATE 42501 and transaction rollback succeeds");
  } finally {
    failingClient.release();
    await admin.query("GRANT SELECT ON actor_lock_test.users TO dadban_actor_lock_owner_ci");
  }
  const recovered = await runtime.query(
    "SELECT * FROM actor_lock_test.lock_live_actor($1,$2,$3)",
    [sessionId,userId,officeId]
  );
  assert(recovered.rows[0]?.valid === true, "actor lock helper did not recover after rollback and privilege repair");
  console.log("PASS: actor lock helper works after rollback and privilege repair");

  const totals = await admin.query(`
    SELECT (SELECT count(*)::int FROM actor_lock_test.users) AS users,
           (SELECT count(*)::int FROM actor_lock_test.auth_sessions) AS sessions,
           (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='actor_lock_test' AND p.proname='lock_live_actor' AND p.prosecdef) AS security_definer_functions
  `);
  console.log("FINAL DISPOSABLE DB COUNTS:", JSON.stringify(totals.rows[0]));
  assert(Number(totals.rows[0].users) === 1 && Number(totals.rows[0].sessions) === 1 &&
    Number(totals.rows[0].security_definer_functions) === 1, "Unexpected final disposable database counts");
} finally {
  await runtime.end();
  if (roleCleanupAuthorized) {
    await admin.query("DROP SCHEMA IF EXISTS actor_lock_test CASCADE").catch(() => {});
    await admin.query("DROP OWNED BY dadban_actor_runtime_ci").catch(() => {});
    await admin.query("DROP OWNED BY dadban_actor_lock_owner_ci").catch(() => {});
    await admin.query("DROP ROLE IF EXISTS dadban_actor_runtime_ci").catch(() => {});
    await admin.query("DROP ROLE IF EXISTS dadban_actor_lock_owner_ci").catch(() => {});
  }
  await admin.end();
}
