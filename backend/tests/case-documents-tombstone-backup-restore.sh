#!/usr/bin/env bash
set -euo pipefail
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then
  echo "Refusing backup/restore test against non-local PostgreSQL" >&2; exit 2
fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then
  echo "Refusing backup/restore test outside dadban_test" >&2; exit 2
fi
backup=/tmp/dadban-tombstone-backup.dump
restore_db=dadban_tombstone_restore_test
export PGPASSWORD=postgres
cleanup() {
  dropdb -h localhost -U postgres --if-exists "$restore_db" >/dev/null 2>&1 || true
  rm -f "$backup"
}
trap cleanup EXIT

before="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d dadban_test -c "
SELECT
 (SELECT count(*) FROM public.case_document_mutation_idempotency),
 (SELECT count(*) FROM public.audit_logs),
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal),
 (SELECT coalesce(string_agg(pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'*')||':'||d.defaclobjtype::text||':'||coalesce(d.defaclacl::text,''), E'\\n' ORDER BY d.defaclrole, n.nspname, d.defaclobjtype), '') FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace);
")"
echo "BACKUP SOURCE DB ASSERTIONS: idempotency_rows,audit_rows,tombstone_triggers,default_acl=$before"

# Fingerprint every non-system relation, sequence, view, function, schema ACL,
# explicit column ACL, owner, and effective object ACL. Compare by qualified
# names, not OIDs, because pg_restore necessarily assigns new OIDs.
catalog_fingerprint() {
  local database="$1"
  psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$database" -c "
WITH inventory(item) AS (
  SELECT format('CLASS|%s|%s|%s|owner=%s|acl=%s', n.nspname, c.relname, c.relkind,
    pg_get_userbyid(c.relowner),
    coalesce(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 'S'::\"char\" ELSE 'r'::\"char\" END, c.relowner))::text)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
    AND c.relkind IN ('r','p','v','m','S','f','i','I','c')
  UNION ALL
  SELECT format('FUNCTION|%s|%s|%s|owner=%s|acl=%s', n.nspname, p.proname,
    pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner),
    coalesce(p.proacl, acldefault('f'::\"char\",p.proowner))::text)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  UNION ALL
  SELECT format('SCHEMA|%s|owner=%s|acl=%s', n.nspname, pg_get_userbyid(n.nspowner),
    coalesce(n.nspacl,acldefault('n'::\"char\",n.nspowner))::text)
  FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  UNION ALL
  SELECT format('COLUMN|%s|%s|%s|acl=%s', n.nspname,c.relname,a.attname,a.attacl::text)
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
)
SELECT coalesce(string_agg(item, E'\\n' ORDER BY item),'') FROM inventory;
"
}
catalog_before="$(catalog_fingerprint dadban_test)"

pg_dump -h localhost -U postgres -Fc -d dadban_test -f "$backup"
createdb -h localhost -U postgres "$restore_db"
# Restore with original owners and ACLs intact. --no-owner would silently make
# SECURITY DEFINER functions owned by postgres, elevating them after recovery.
pg_restore -h localhost -U postgres -d "$restore_db" "$backup"

after="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$restore_db" -c "
SELECT
 (SELECT count(*) FROM public.case_document_mutation_idempotency),
 (SELECT count(*) FROM public.audit_logs),
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal),
 (SELECT coalesce(string_agg(pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'*')||':'||d.defaclobjtype::text||':'||coalesce(d.defaclacl::text,''), E'\\n' ORDER BY d.defaclrole, n.nspname, d.defaclobjtype), '') FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace);
")"
if [[ "$before" != "$after" ]]; then
  echo "FAIL: restore counts/trigger state differ: before=$before after=$after" >&2; exit 1
fi
echo "RESTORED DB ASSERTIONS: idempotency_rows,audit_rows,tombstone_triggers,default_acl=$after"

catalog_after="$(catalog_fingerprint "$restore_db")"
if [[ "$catalog_before" != "$catalog_after" ]]; then
  echo "FAIL: object ownership/effective ACL inventory differs after pg_dump/pg_restore" >&2
  diff -u <(printf '%s\\n' "$catalog_before") <(printf '%s\\n' "$catalog_after") || true
  exit 1
fi
echo "PASS: pg_dump/pg_restore preserves ownership and effective ACL fingerprints for tables, views, sequences, functions, schemas, and explicit column grants"

# A successful row/trigger restore is not enough: SECURITY DEFINER owners and
# effective ACLs must survive the dump. Check all eight restricted helpers.
psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d "$restore_db" <<'SQL'
DO $definer_restore$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT * FROM (VALUES
      ('public.lock_live_document_actor(uuid,uuid,uuid)'::regprocedure, 'dadban_actor_lock_owner'),
      ('public.lock_live_client_parent(uuid,uuid)'::regprocedure, 'dadban_actor_lock_owner'),
      ('public.lock_live_case_client(uuid,uuid)'::regprocedure, 'dadban_actor_lock_owner'),
      ('public.lock_live_case_parents(uuid,uuid[])'::regprocedure, 'dadban_actor_lock_owner'),
      ('public.lock_live_case_reassignment(uuid,uuid,uuid)'::regprocedure, 'dadban_actor_lock_owner'),
      ('public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure, 'dadban_api_idempotency_owner'),
      ('public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure, 'dadban_api_idempotency_owner'),
      ('public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)'::regprocedure, 'dadban_api_idempotency_owner')
    ) AS expected(oid, expected_owner)
  LOOP
    IF (SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=fn.oid)
       IS DISTINCT FROM fn.expected_owner THEN
      RAISE EXCEPTION 'restored SECURITY DEFINER function % has unexpected owner', fn.oid;
    END IF;
    IF EXISTS (
      SELECT 1 FROM aclexplode(coalesce(
        (SELECT p.proacl FROM pg_proc p WHERE p.oid=fn.oid),
        acldefault('f', (SELECT p.proowner FROM pg_proc p WHERE p.oid=fn.oid))
      )) acl
      WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ) THEN
      RAISE EXCEPTION 'PUBLIC can execute restored SECURITY DEFINER function %', fn.oid;
    END IF;
    IF NOT has_function_privilege('dadban_document_runtime_ci', fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'approved runtime lost EXECUTE on restored function %', fn.oid;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member
    WHERE r.rolname IN ('dadban_actor_lock_owner','dadban_api_idempotency_owner')
  ) THEN
    RAISE EXCEPTION 'restored SECURITY DEFINER owner unexpectedly participates in role membership';
  END IF;
END
$definer_restore$;
SQL
echo "PASS: backup/restore preserves default ACLs, all eight SECURITY DEFINER owners, denies PUBLIC EXECUTE, and retains approved runtime EXECUTE"

# Migration 007 must not be re-applied over a restored DB; failure must leave
# the restored protection/catalog intact.
if psql -h localhost -U postgres -d "$restore_db" -v ON_ERROR_STOP=1 -f migrations/007_case_document_mutation_tombstones.sql >/tmp/dadban-restored-migration-rerun.log 2>&1; then
  echo "FAIL: migration 007 unexpectedly succeeded after restore" >&2; exit 1
fi
post="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$restore_db" -c "
SELECT
 (SELECT count(*) FROM pg_attribute WHERE attrelid='public.case_document_mutation_idempotency'::regclass AND attname='purged_at' AND NOT attisdropped),
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal),
 (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='case_document_mutation_idempotency' AND indexname='case_document_mutation_idempotency_purged_at_idx');
")"
if [[ "$post" != "1|2|1" ]]; then
 echo "FAIL: restored schema protection changed after migration rerun failure: $post" >&2; exit 1
fi
echo "PASS: PostgreSQL backup/restore preserves idempotency and audit counts; migration 007 re-run after restore fails without losing tombstone protections"

# Start a fresh API process against the restored database and replay the exact
# key whose response data was purged before backup. The API must return 410 and
# direct PostgreSQL counts must remain unchanged.
DATABASE_URL=postgres://postgres:postgres@localhost:5432/dadban_tombstone_restore_test node tests/case-documents-tombstone-restore-replay.integration.js

