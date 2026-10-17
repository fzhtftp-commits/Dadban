#!/usr/bin/env bash
set -euo pipefail
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then echo "Refusing ACL matrix test against non-local PostgreSQL" >&2; exit 2; fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then echo "Refusing ACL matrix test outside dadban_test" >&2; exit 2; fi
export PGPASSWORD=postgres
db=dadban_test
schema=dadban_acl_matrix_ci
owner=dadban_acl_owner_matrix_ci
alt=dadban_acl_alt_owner_matrix_ci
migrator=dadban_acl_migrator_matrix_ci
maintenance=dadban_acl_maintenance_matrix_ci
backup=dadban_acl_backup_matrix_ci
runtime=dadban_acl_runtime_matrix_ci
cleanup() {
  psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL || true
REVOKE $owner FROM $migrator;
REVOKE $alt FROM $owner;
DROP SCHEMA IF EXISTS $schema CASCADE;
DROP ROLE IF EXISTS $migrator;
DROP ROLE IF EXISTS $maintenance;
DROP ROLE IF EXISTS $backup;
DROP ROLE IF EXISTS $runtime;
DROP ROLE IF EXISTS $owner;
DROP ROLE IF EXISTS $alt;
SQL
}
trap cleanup EXIT
guard="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$db" -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('$owner','$alt','$migrator','$maintenance','$backup','$runtime');")"
if [[ "$guard" != "0" ]]; then echo "FAIL: refusing to reuse pre-existing ACL matrix roles: $guard" >&2; exit 1; fi
if [[ "$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$db" -c "SELECT count(*) FROM pg_namespace WHERE nspname='$schema'")" != "0" ]]; then echo "FAIL: refusing to reuse pre-existing ACL matrix schema" >&2; exit 1; fi

psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE $owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $alt NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $maintenance NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT $owner TO $migrator;
GRANT $alt TO $owner;
CREATE SCHEMA $schema AUTHORIZATION $owner;
GRANT USAGE ON SCHEMA $schema TO $migrator, $maintenance, $backup, $runtime;
GRANT CREATE ON SCHEMA $schema TO $alt;
SET ROLE $owner;
CREATE SEQUENCE $schema.fixture_seq;
CREATE TABLE $schema.fixture_table (id bigint NOT NULL DEFAULT nextval('$schema.fixture_seq'), note text NOT NULL);
ALTER SEQUENCE $schema.fixture_seq OWNED BY $schema.fixture_table.id;
CREATE VIEW $schema.fixture_view AS SELECT id, note FROM $schema.fixture_table;
CREATE FUNCTION $schema.fixture_fn() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS \$\$ SELECT 7 \$\$;
REVOKE ALL ON FUNCTION $schema.fixture_fn() FROM PUBLIC;
RESET ROLE;
GRANT SELECT ON $schema.fixture_table, $schema.fixture_view TO $maintenance, $backup;
GRANT SELECT ON SEQUENCE $schema.fixture_seq TO $backup;
GRANT EXECUTE ON FUNCTION $schema.fixture_fn() TO $runtime;
SQL

psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 <<SQL
DO \$audit\$
DECLARE object_owner text; grantable_count integer;
BEGIN
  SELECT r.rolname INTO object_owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='$schema.fixture_table'::regclass;
  IF object_owner IS DISTINCT FROM '$owner' THEN RAISE EXCEPTION 'table owner mismatch: %',object_owner; END IF;
  SELECT r.rolname INTO object_owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='$schema.fixture_view'::regclass;
  IF object_owner IS DISTINCT FROM '$owner' THEN RAISE EXCEPTION 'view owner mismatch: %',object_owner; END IF;
  SELECT r.rolname INTO object_owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='$schema.fixture_seq'::regclass;
  IF object_owner IS DISTINCT FROM '$owner' THEN RAISE EXCEPTION 'sequence owner mismatch: %',object_owner; END IF;
  SELECT r.rolname INTO object_owner FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='$schema.fixture_fn()'::regprocedure;
  IF object_owner IS DISTINCT FROM '$owner' THEN RAISE EXCEPTION 'function owner mismatch: %',object_owner; END IF;

  IF NOT pg_has_role('$migrator','$owner','MEMBER') OR NOT pg_has_role('$migrator','$alt','MEMBER') THEN RAISE EXCEPTION 'migrator lacks expected direct/transitive membership'; END IF;
  IF pg_has_role('$runtime','$owner','MEMBER') OR pg_has_role('$runtime','$alt','MEMBER') OR pg_has_role('$maintenance','$owner','MEMBER') OR pg_has_role('$backup','$owner','MEMBER') THEN
    RAISE EXCEPTION 'runtime/maintenance/backup unexpectedly has owner membership';
  END IF;
  IF has_schema_privilege('$runtime','$schema','CREATE') OR has_schema_privilege('$maintenance','$schema','CREATE') OR has_schema_privilege('$backup','$schema','CREATE') THEN
    RAISE EXCEPTION 'runtime/maintenance/backup has CREATE on fixture schema';
  END IF;
  IF NOT has_table_privilege('$maintenance','$schema.fixture_table','SELECT') OR NOT has_table_privilege('$maintenance','$schema.fixture_view','SELECT') THEN
    RAISE EXCEPTION 'maintenance SELECT contract missing';
  END IF;
  IF has_table_privilege('$maintenance','$schema.fixture_table','INSERT') OR has_table_privilege('$maintenance','$schema.fixture_table','UPDATE')
     OR has_table_privilege('$maintenance','$schema.fixture_table','DELETE') OR has_sequence_privilege('$maintenance','$schema.fixture_seq','USAGE')
     OR has_sequence_privilege('$maintenance','$schema.fixture_seq','UPDATE') THEN
    RAISE EXCEPTION 'maintenance exceeds read-only fixture contract';
  END IF;
  IF NOT has_table_privilege('$backup','$schema.fixture_table','SELECT') OR NOT has_table_privilege('$backup','$schema.fixture_view','SELECT')
     OR NOT has_sequence_privilege('$backup','$schema.fixture_seq','SELECT') THEN RAISE EXCEPTION 'backup read contract missing'; END IF;
  IF has_table_privilege('$backup','$schema.fixture_table','INSERT') OR has_table_privilege('$backup','$schema.fixture_table','UPDATE')
     OR has_table_privilege('$backup','$schema.fixture_table','DELETE') THEN RAISE EXCEPTION 'backup role exceeds read-only fixture contract'; END IF;
  IF has_table_privilege('$runtime','$schema.fixture_table','SELECT') OR has_table_privilege('$runtime','$schema.fixture_table','INSERT')
     OR has_sequence_privilege('$runtime','$schema.fixture_seq','USAGE') OR NOT has_function_privilege('$runtime','$schema.fixture_fn()','EXECUTE') THEN
    RAISE EXCEPTION 'runtime object/function ACL contract mismatch';
  END IF;
  SELECT count(*) INTO grantable_count FROM (
    SELECT a.grantee,a.is_grantable FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
      WHERE c.oid IN ('$schema.fixture_table'::regclass,'$schema.fixture_view'::regclass,'$schema.fixture_seq'::regclass)
    UNION ALL
    SELECT a.grantee,a.is_grantable FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='$schema.fixture_fn()'::regprocedure
  ) acl WHERE acl.is_grantable AND acl.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('$migrator','$maintenance','$backup','$runtime'));
  IF grantable_count <> 0 THEN RAISE EXCEPTION 'non-owner role has unexpected direct GRANT OPTION: %',grantable_count; END IF;
END
\$audit\$;
SQL

# Test SET ROLE as the non-superuser session identity; each psql process is disposable.
if psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION $runtime; SET ROLE $owner" >/tmp/dadban-acl-runtime-set-role.log 2>&1; then
  echo "FAIL: runtime unexpectedly SET ROLE to schema owner" >&2; exit 1
fi
psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION $migrator; SET ROLE $owner" >/dev/null
psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION $migrator; SET ROLE $alt" >/dev/null
echo "PASS: independent ACL matrix verified table/view/sequence/function ownership, migrator SET ROLE, maintenance/backup read-only grants, runtime denial, and absence of unintended direct GRANT OPTION"
