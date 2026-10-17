#!/usr/bin/env bash
set -euo pipefail
# Full pg_dump/pg_restore role-boundary test. All databases and roles are CI-only.
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then
  echo "Refusing role-boundary restore test against non-local PostgreSQL" >&2; exit 2
fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then
  echo "Refusing role-boundary restore test outside dadban_test" >&2; exit 2
fi
export PGPASSWORD=postgres
admin=postgres
source_db=dadban_restore_role_source_ci
target_db=dadban_restore_role_target_ci
schema=dadban_restore_role_fixture
owner_a=dadban_rr_owner_a_ci
owner_b=dadban_rr_owner_b_ci
bridge=dadban_rr_owner_bridge_ci
restore=dadban_rr_restore_executor_ci
backup=dadban_rr_backup_reader_ci
dump=/tmp/dadban-restore-role-boundary.dump
cleanup() {
  dropdb -h localhost -U "$admin" --if-exists "$target_db" >/dev/null 2>&1 || true
  dropdb -h localhost -U "$admin" --if-exists "$source_db" >/dev/null 2>&1 || true
  rm -f "$dump"
  psql -h localhost -U "$admin" -d dadban_test -X -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL || true
REVOKE $owner_a FROM $bridge;
REVOKE $bridge FROM $restore;
REVOKE $owner_b FROM $bridge;
DROP ROLE IF EXISTS $backup;
DROP ROLE IF EXISTS $restore;
DROP ROLE IF EXISTS $bridge;
DROP ROLE IF EXISTS $owner_a;
DROP ROLE IF EXISTS $owner_b;
SQL
}
trap cleanup EXIT
existing="$(psql -h localhost -U "$admin" -X -A -t -v ON_ERROR_STOP=1 -d dadban_test -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('$owner_a','$owner_b','$bridge','$restore','$backup')")"
if [[ "$existing" != "0" ]]; then echo "Refusing to reuse pre-existing test roles: $existing" >&2; exit 2; fi
psql -h localhost -U "$admin" -d dadban_test -X -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE $owner_a NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $owner_b NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE $bridge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
CREATE ROLE $restore LOGIN PASSWORD 'ci-only-restore-role-password' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
CREATE ROLE $backup LOGIN PASSWORD 'ci-only-backup-role-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT $owner_a TO $bridge;
GRANT $owner_b TO $bridge;
GRANT $bridge TO $restore;
SQL
createdb -h localhost -U "$admin" "$source_db"
psql -h localhost -U "$admin" -d "$source_db" -X -v ON_ERROR_STOP=1 <<SQL
GRANT CONNECT ON DATABASE $source_db TO $backup;
GRANT CONNECT ON DATABASE $source_db TO $restore;
CREATE SCHEMA $schema AUTHORIZATION $owner_a;
GRANT CREATE ON SCHEMA $schema TO $owner_b;
SET ROLE $owner_a;
CREATE TABLE $schema.fixture_table(id bigint PRIMARY KEY, payload text NOT NULL);
INSERT INTO $schema.fixture_table VALUES (1,'restore-fixture');
CREATE VIEW $schema.fixture_view AS SELECT id,payload FROM $schema.fixture_table;
RESET ROLE;
SET ROLE $owner_b;
CREATE SEQUENCE $schema.fixture_seq START 17;
CREATE FUNCTION $schema.fixture_fn() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS \$\$ SELECT 42 \$\$;
RESET ROLE;
GRANT USAGE ON SCHEMA $schema TO $backup;
GRANT SELECT ON $schema.fixture_table,$schema.fixture_view TO $backup;
GRANT SELECT ON SEQUENCE $schema.fixture_seq TO $backup;
GRANT USAGE ON SCHEMA $schema TO $restore;
GRANT CREATE ON SCHEMA $schema TO $restore;
SQL
# The restore role must be able to read a real custom-format dump, but cannot
# create databases or cluster roles. Confirm the privilege boundary first.
psql -h localhost -U "$admin" -d "$source_db" -X -v ON_ERROR_STOP=1 <<SQL
DO \$guard\$
BEGIN
 IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='$backup') THEN
   RAISE EXCEPTION 'backup reader has cluster administration privileges';
 END IF;
 IF has_table_privilege('$backup','$schema.fixture_table','INSERT')
    OR has_table_privilege('$backup','$schema.fixture_table','UPDATE')
    OR has_table_privilege('$backup','$schema.fixture_table','DELETE')
    OR has_schema_privilege('$backup','$schema','CREATE') THEN
   RAISE EXCEPTION 'backup reader has write/create privilege';
 END IF;
 IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname='$restore') THEN
   RAISE EXCEPTION 'restore executor has cluster administration privileges';
 END IF;
 IF NOT pg_has_role('$restore','$owner_a','MEMBER')
    OR NOT pg_has_role('$restore','$owner_b','MEMBER') THEN
   RAISE EXCEPTION 'restore executor lacks indirect membership in both object owners';
 END IF;
END
\$guard\$;
SQL
# Exercise transitive SET ROLE as the actual authenticated restore identity,
# not via the postgres superuser; the backup reader must not be able to switch.
PGPASSWORD=ci-only-restore-role-password psql -h localhost -U "$restore" -d "$source_db" -X -v ON_ERROR_STOP=1 -c "SET ROLE $owner_a; RESET ROLE; SET ROLE $owner_b; RESET ROLE" >/dev/null
if PGPASSWORD=ci-only-backup-role-password psql -h localhost -U "$backup" -d "$source_db" -X -v ON_ERROR_STOP=1 -c "SET ROLE $owner_a" >/tmp/dadban-rr-backup-set-role.log 2>&1; then
  echo "FAIL: read-only backup reader unexpectedly SET ROLE to an object owner" >&2; exit 1
fi
# Capture the cluster-global indirect membership graph before restore; pg_dump archives
# database objects, not pg_auth_members, so restoration must not be mistaken for role provisioning.
membership_before="$(psql -h localhost -U "$admin" -d dadban_test -X -A -t -v ON_ERROR_STOP=1 -c "
SELECT string_agg(member.rolname||'->'||granted.rolname,',' ORDER BY member.rolname,granted.rolname)
FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
WHERE (member.rolname,granted.rolname) IN (('$bridge','$owner_a'),('$bridge','$owner_b'),('$restore','$bridge'))")"
if [[ "$membership_before" != "$bridge->$owner_a,$bridge->$owner_b,$restore->$bridge" ]]; then
  echo "FAIL: unexpected pre-restore indirect membership graph: $membership_before" >&2; exit 1
fi
# This is a real pg_dump under the read-only backup identity.
PGPASSWORD=ci-only-backup-role-password pg_dump -h localhost -U "$backup" -Fc --schema="$schema" -d "$source_db" -f "$dump"
if [[ ! -s "$dump" ]]; then echo "FAIL: read-only backup role produced an empty dump" >&2; exit 1; fi

# Create the target database as the DBA, then grant only CONNECT/CREATE on that
# database to the restore executor. It deliberately has no CREATEDB, CREATEROLE,
# SUPERUSER, or ownership of the target database. Owner roles receive CREATE on
# this test database because PostgreSQL requires it when changing schema owner.
createdb -h localhost -U "$admin" "$target_db"
psql -h localhost -U "$admin" -d dadban_test -X -v ON_ERROR_STOP=1 <<SQL
GRANT CONNECT, CREATE ON DATABASE $target_db TO $restore;
GRANT CREATE ON DATABASE $target_db TO $owner_a, $owner_b;
SQL
psql -h localhost -U "$admin" -d "$target_db" -X -v ON_ERROR_STOP=1 <<SQL
GRANT CONNECT ON DATABASE $target_db TO $restore;
SQL
# A schema dump includes owner/ACL commands. pg_restore connects as the
# non-superuser role; no --no-owner is used, so ownership must really restore.
PGPASSWORD=ci-only-restore-role-password pg_restore -h localhost -U "$restore" -d "$target_db" "$dump"

fingerprint() {
  local db="$1"
  psql -h localhost -U "$admin" -d "$db" -X -A -t -v ON_ERROR_STOP=1 -c "
WITH inventory(item) AS (
 SELECT format('CLASS|%s|%s|%s|owner=%s|acl=%s',n.nspname,c.relname,c.relkind,
   pg_get_userbyid(c.relowner),
   coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END,c.relowner))::text)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='$schema' AND c.relkind IN ('r','p','v','m','S','f','i','I','c')
 UNION ALL
 SELECT format('FUNCTION|%s|%s|%s|owner=%s|acl=%s',n.nspname,p.proname,
   pg_get_function_identity_arguments(p.oid),pg_get_userbyid(p.proowner),
   coalesce(p.proacl,acldefault('f'::\"char\",p.proowner))::text)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='$schema'
 UNION ALL
 SELECT format('SCHEMA|%s|owner=%s|acl=%s',n.nspname,pg_get_userbyid(n.nspowner),
   coalesce(n.nspacl,acldefault('n'::\"char\",n.nspowner))::text)
 FROM pg_namespace n WHERE n.nspname='$schema'
 UNION ALL
 SELECT format('COLUMN|%s|%s|%s|acl=%s',n.nspname,c.relname,a.attname,a.attacl::text)
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='$schema' AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
)
SELECT coalesce(string_agg(item,E'\\n' ORDER BY item),'') FROM inventory;"
}
source_fp="$(fingerprint "$source_db")"
target_fp="$(fingerprint "$target_db")"
if [[ "$source_fp" != "$target_fp" ]]; then
 echo "FAIL: real non-superuser pg_restore changed owner/ACL fingerprint" >&2
 diff -u <(printf '%s\\n' "$source_fp") <(printf '%s\\n' "$target_fp") || true
 exit 1
fi
echo "PASS: real pg_dump by read-only role and pg_restore by non-superuser preserve table/view/sequence/function/schema/column ACL and ownership fingerprints"

# Explicitly compare direct ACL grant-option state for both operational test roles
# in source and restored databases; the full ACL fingerprint above also covers all grantees.
assert_no_role_grant_option() {
  local db="$1"
  psql -h localhost -U "$admin" -d "$db" -X -v ON_ERROR_STOP=1 <<SQL
DO \$acl_guard\$
DECLARE backup_oid oid := (SELECT oid FROM pg_roles WHERE rolname='$backup');
        restore_oid oid := (SELECT oid FROM pg_roles WHERE rolname='$restore');
BEGIN
 IF EXISTS (
   SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
   JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='$schema' AND a.grantee IN (backup_oid,restore_oid) AND a.is_grantable
 ) OR EXISTS (
   SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f'::"char",p.proowner))) a
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='$schema' AND a.grantee IN (backup_oid,restore_oid) AND a.is_grantable
 ) THEN RAISE EXCEPTION 'backup/restore role unexpectedly has object GRANT OPTION in database %', current_database(); END IF;
END
\$acl_guard\$;
SQL
}
assert_no_role_grant_option "$source_db"
assert_no_role_grant_option "$target_db"

# The role-membership graph is cluster-global (not carried by pg_dump); verify
# the explicit indirect edges still exist and SET ROLE works after restore.
PGPASSWORD=ci-only-restore-role-password psql -h localhost -U "$restore" -d "$target_db" -X -v ON_ERROR_STOP=1 -c "SET ROLE $owner_a; RESET ROLE; SET ROLE $owner_b; RESET ROLE" >/dev/null
membership_after="$(psql -h localhost -U "$admin" -d dadban_test -X -A -t -v ON_ERROR_STOP=1 -c "
SELECT string_agg(member.rolname||'->'||granted.rolname,',' ORDER BY member.rolname,granted.rolname)
FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
WHERE (member.rolname,granted.rolname) IN (('$bridge','$owner_a'),('$bridge','$owner_b'),('$restore','$bridge'))")"
if [[ "$membership_before" != "$membership_after" ]]; then
 echo "FAIL: indirect role membership graph changed during restore: before=$membership_before after=$membership_after" >&2; exit 1
fi
echo "PASS: indirect membership graph preserved; transitive SET ROLE works for restore; backup reader cannot SET ROLE and neither role has GRANT OPTION"
