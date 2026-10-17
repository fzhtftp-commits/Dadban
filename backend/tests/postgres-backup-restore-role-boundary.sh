#!/usr/bin/env bash
set -euo pipefail
# Disposable PostgreSQL only: never run this privilege probe against a hosted DB.
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then echo "Refusing backup/restore role test against non-local PostgreSQL" >&2; exit 2; fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then echo "Refusing backup/restore role test outside dadban_test" >&2; exit 2; fi
export PGPASSWORD=postgres
db=dadban_test
schema=dadban_backup_restore_roles_ci
owner=dadban_br_owner_ci
backup=dadban_br_reader_ci
restore=dadban_br_restore_ci
cleanup() {
 psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL || true
REVOKE $owner FROM $restore;
DROP SCHEMA IF EXISTS $schema CASCADE;
DROP ROLE IF EXISTS $backup;
DROP ROLE IF EXISTS $restore;
DROP ROLE IF EXISTS $owner;
SQL
}
trap cleanup EXIT
guard="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$db" -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('$owner','$backup','$restore')")"
if [[ "$guard" != "0" ]]; then echo "Refusing to reuse pre-existing backup/restore probe roles: $guard" >&2; exit 2; fi
psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE $owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $restore NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE SCHEMA $schema AUTHORIZATION $owner;
GRANT USAGE ON SCHEMA $schema TO $backup, $restore;
GRANT $owner TO $restore;
SET ROLE $owner;
CREATE TABLE $schema.fixture_table(id bigint PRIMARY KEY, payload text NOT NULL);
CREATE SEQUENCE $schema.fixture_seq;
CREATE VIEW $schema.fixture_view AS SELECT id,payload FROM $schema.fixture_table;
CREATE FUNCTION $schema.fixture_fn() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS \$\$ SELECT 1 \$\$;
REVOKE ALL ON FUNCTION $schema.fixture_fn() FROM PUBLIC;
RESET ROLE;
GRANT SELECT ON $schema.fixture_table,$schema.fixture_view TO $backup;
GRANT SELECT ON SEQUENCE $schema.fixture_seq TO $backup;
GRANT SELECT ON $schema.fixture_table,$schema.fixture_view TO $restore;
GRANT SELECT ON SEQUENCE $schema.fixture_seq TO $restore;
SQL
psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 <<SQL
DO \$audit\$
DECLARE
 owner_oid oid := (SELECT oid FROM pg_roles WHERE rolname='$owner');
 backup_oid oid := (SELECT oid FROM pg_roles WHERE rolname='$backup');
 restore_oid oid := (SELECT oid FROM pg_roles WHERE rolname='$restore');
BEGIN
 IF NOT has_schema_privilege('$backup','$schema','USAGE')
    OR NOT has_table_privilege('$backup','$schema.fixture_table','SELECT')
    OR NOT has_table_privilege('$backup','$schema.fixture_view','SELECT')
    OR NOT has_sequence_privilege('$backup','$schema.fixture_seq','SELECT') THEN
   RAISE EXCEPTION 'backup reader lacks minimum fixture read privileges';
 END IF;
 IF has_schema_privilege('$backup','$schema','CREATE')
    OR has_table_privilege('$backup','$schema.fixture_table','INSERT')
    OR has_table_privilege('$backup','$schema.fixture_table','UPDATE')
    OR has_table_privilege('$backup','$schema.fixture_table','DELETE')
    OR has_sequence_privilege('$backup','$schema.fixture_seq','USAGE')
    OR pg_has_role(backup_oid,owner_oid,'MEMBER') THEN
   RAISE EXCEPTION 'backup reader has write/ownership escalation privileges';
 END IF;
 IF NOT pg_has_role(restore_oid,owner_oid,'MEMBER') THEN
   RAISE EXCEPTION 'test restore executor lacks explicitly modeled owner membership';
 END IF;
 IF (SELECT rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE oid=restore_oid) THEN
   RAISE EXCEPTION 'restore executor must not be superuser or cluster-role/database administrator';
 END IF;
 IF EXISTS (
   SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
   WHERE c.oid IN ('$schema.fixture_table'::regclass,'$schema.fixture_view'::regclass,'$schema.fixture_seq'::regclass)
     AND a.grantee IN (backup_oid,restore_oid) AND a.is_grantable
 ) THEN RAISE EXCEPTION 'backup/restore fixture role unexpectedly has object GRANT OPTION'; END IF;
END
\$audit\$;
SQL
# SET SESSION AUTHORIZATION makes PostgreSQL evaluate SET ROLE as the actual fixture role,
# rather than accidentally testing the postgres superuser's powers.
if psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION $backup; SET ROLE $owner" >/tmp/dadban-backup-reader-set-role.log 2>&1; then
 echo "FAIL: read-only backup role unexpectedly SET ROLE to object owner" >&2; exit 1
fi
psql -h localhost -U postgres -d "$db" -X -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION $restore; SET ROLE $owner" >/dev/null
echo "PASS: backup reader has fixture read-only ACL and cannot SET ROLE owner; separate restore executor has explicit owner membership, SET ROLE works, neither role has GRANT OPTION or superuser privileges"
