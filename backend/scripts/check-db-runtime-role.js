import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Set it in the execution environment; never paste it into source code or logs.");
  process.exitCode = 1;
} else {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
    statement_timeout: 10000
  });

  try {
    await client.connect();

    const identity = await client.query(`
      select current_user as current_user,
             session_user as session_user,
             r.rolsuper as is_superuser,
             r.rolbypassrls as bypasses_rls,
             r.rolcanlogin as can_login
      from pg_roles r
      where r.rolname = current_user
    `);

    const tableGrants = await client.query(`
      select table_name,
             has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'SELECT') as can_select,
             has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'INSERT') as can_insert,
             has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'UPDATE') as can_update,
             has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'DELETE') as can_delete
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
        and table_name = any($1::text[])
      order by table_name
    `, [[
      "offices", "users", "auth_credentials", "auth_sessions",
      "clients", "cases", "hearings", "audit_logs"
    ]]);

    console.log("Runtime database role (no credentials are printed):");
    console.log(JSON.stringify(identity.rows[0] ?? null, null, 2));
    console.log("Table privileges:");
    console.log(JSON.stringify(tableGrants.rows, null, 2));
  } catch (error) {
    console.error("Could not inspect runtime database role:", error.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
