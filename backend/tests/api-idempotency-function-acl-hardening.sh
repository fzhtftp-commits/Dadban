#!/usr/bin/env bash
set -euo pipefail

if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then
  echo "Refusing SECURITY DEFINER ACL test against non-local PostgreSQL" >&2
  exit 2
fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then
  echo "Refusing SECURITY DEFINER ACL test outside dadban_test" >&2
  exit 2
fi
export PGPASSWORD=postgres

# Never adopt or remove names that predate this test.
preexisting="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d dadban_test -c "
SELECT count(*) FROM pg_roles
WHERE rolname IN ('dadban_api_idempotency_acl_probe_ci','dadban_api_idempotency_member_probe_ci');
")"
if [[ "$preexisting" != "0" ]]; then
  echo "Refusing to reuse pre-existing idempotency ACL probe roles" >&2
  exit 2
fi

cleanup() {
  psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d dadban_test <<'SQL' >/dev/null
DO $cleanup$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_api_idempotency_member_probe_ci')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_ci') THEN
    EXECUTE 'REVOKE dadban_document_runtime_ci FROM dadban_api_idempotency_member_probe_ci';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_api_idempotency_member_probe_ci')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_api_idempotency_acl_probe_ci') THEN
    EXECUTE 'REVOKE dadban_api_idempotency_acl_probe_ci FROM dadban_api_idempotency_member_probe_ci';
  END IF;
END
$cleanup$;
DROP ROLE IF EXISTS dadban_api_idempotency_acl_probe_ci;
DROP ROLE IF EXISTS dadban_api_idempotency_member_probe_ci;
SQL
}
trap cleanup EXIT

# The baseline migration-upgrade test does not install proof functions; establish
# the current migration state before seeding stale grants for the rerun regression.
psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d dadban_test -f migrations/013_api_mutation_idempotency_proof_functions.sql

psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d dadban_test <<'SQL'
CREATE ROLE dadban_api_idempotency_acl_probe_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE dadban_api_idempotency_member_probe_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT dadban_api_idempotency_acl_probe_ci TO dadban_api_idempotency_member_probe_ci;
GRANT EXECUTE ON FUNCTION public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) TO dadban_api_idempotency_acl_probe_ci;
GRANT EXECUTE ON FUNCTION public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) TO dadban_api_idempotency_acl_probe_ci;
GRANT EXECUTE ON FUNCTION public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text) TO dadban_api_idempotency_acl_probe_ci;
-- Seed a stale delegation right: rerunning migration must not leave runtime able
-- to grant these SECURITY DEFINER functions to an intermediary role.
GRANT EXECUTE ON FUNCTION public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) TO dadban_document_runtime_ci WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) TO dadban_document_runtime_ci WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text) TO dadban_document_runtime_ci WITH GRANT OPTION;
SQL

# Reapplying migration 013 must remove stale explicit EXECUTE grants on CREATE OR REPLACE functions.
psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d dadban_test -f migrations/013_api_mutation_idempotency_proof_functions.sql
psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d dadban_test <<'SQL'
DO $assert_acl$
BEGIN
  IF has_function_privilege('dadban_api_idempotency_acl_probe_ci',
       'public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
     OR has_function_privilege('dadban_api_idempotency_acl_probe_ci',
       'public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
     OR has_function_privilege('dadban_api_idempotency_acl_probe_ci',
       'public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)','EXECUTE') THEN
    RAISE EXCEPTION 'unexpected role retained EXECUTE after migration rerun';
  END IF;
  IF has_function_privilege('dadban_api_idempotency_member_probe_ci',
       'public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
     OR has_function_privilege('dadban_api_idempotency_member_probe_ci',
       'public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
     OR has_function_privilege('dadban_api_idempotency_member_probe_ci',
       'public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)','EXECUTE') THEN
    RAISE EXCEPTION 'intermediary role membership retained effective EXECUTE after migration rerun';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    WHERE p.oid IN (
      'public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,
      'public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,
      'public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)'::regprocedure
    )
      AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname='dadban_document_runtime_ci')
      AND acl.privilege_type='EXECUTE'
      AND acl.is_grantable
  ) THEN
    RAISE EXCEPTION 'runtime retained grant option on a SECURITY DEFINER function after migration rerun';
  END IF;
  IF NOT has_function_privilege('dadban_document_runtime_ci',
       'public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('dadban_document_runtime_ci',
       'public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)','EXECUTE')
     OR NOT has_function_privilege('dadban_document_runtime_ci',
       'public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)','EXECUTE') THEN
    RAISE EXCEPTION 'expected runtime EXECUTE grant was lost';
  END IF;
END
$assert_acl$;
SQL
echo "PASS: migration rerun removes stale direct/inherited grants and runtime grant options while preserving plain EXECUTE"

# A role granted membership in the runtime role must be rejected in either membership direction.
psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d dadban_test -c   "GRANT dadban_document_runtime_ci TO dadban_api_idempotency_member_probe_ci"
if psql -h localhost -U postgres -X -v ON_ERROR_STOP=1 -d dadban_test -f migrations/013_api_mutation_idempotency_proof_functions.sql; then
  echo "Migration unexpectedly accepted a role granted membership in the runtime role" >&2
  exit 1
else
  echo "PASS: migration rejects membership granted to the runtime role"
fi
