#!/usr/bin/env bash
set -euo pipefail
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then echo "Refusing role-boundary test against non-local PostgreSQL" >&2; exit 2; fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then echo "Refusing role-boundary test outside dadban_test" >&2; exit 2; fi
export PGPASSWORD=postgres
psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1 <<'SQL'
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_schema_owner_ci') THEN CREATE ROLE dadban_schema_owner_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_schema_owner_alt_ci') THEN CREATE ROLE dadban_schema_owner_alt_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_migrator_ci') THEN CREATE ROLE dadban_migrator_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_maintenance_ci') THEN CREATE ROLE dadban_maintenance_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF;
END
$roles$;
ALTER ROLE dadban_schema_owner_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE dadban_schema_owner_alt_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE dadban_migrator_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE dadban_maintenance_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CREATE ON SCHEMA public TO dadban_schema_owner_ci, dadban_schema_owner_alt_ci;
GRANT dadban_schema_owner_ci, dadban_schema_owner_alt_ci TO dadban_migrator_ci;
ALTER TABLE public.case_document_mutation_idempotency OWNER TO dadban_schema_owner_ci;
REVOKE ALL ON public.case_document_mutation_idempotency FROM dadban_maintenance_ci;
GRANT SELECT ON public.case_document_mutation_idempotency TO dadban_maintenance_ci;
SQL

# Migration role is explicitly elevated via membership in the schema-owner roles.
# Verify it can alter trigger state and table ownership, but rollback both changes.
psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL ROLE dadban_migrator_ci;
ALTER TABLE public.case_document_mutation_idempotency DISABLE TRIGGER case_document_mutation_idempotency_identity_immutable;
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname='case_document_mutation_idempotency_identity_immutable' AND tgenabled='D') THEN
    RAISE EXCEPTION 'migration role could not disable trigger as expected';
  END IF;
END
$assert$;
ALTER TABLE public.case_document_mutation_idempotency ENABLE TRIGGER case_document_mutation_idempotency_identity_immutable;
ALTER TABLE public.case_document_mutation_idempotency OWNER TO dadban_schema_owner_alt_ci;
ROLLBACK;
SQL

# Runtime and maintenance roles must not be table owner, member of owner/migrator,
# superuser, or createrole; neither may disable triggers or change table ownership.
for role in dadban_document_runtime_ci dadban_maintenance_ci; do
  for sql in     "ALTER TABLE public.case_document_mutation_idempotency DISABLE TRIGGER case_document_mutation_idempotency_identity_immutable"     "ALTER TABLE public.case_document_mutation_idempotency OWNER TO dadban_schema_owner_alt_ci"; do
    if psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1 -c "SET ROLE $role; $sql" >/tmp/dadban-role-denied.log 2>&1; then
      echo "FAIL: $role unexpectedly succeeded: $sql" >&2; exit 1
    fi
  done
  if psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1 -c "SET ROLE $role; TRUNCATE public.case_document_mutation_idempotency" >/tmp/dadban-role-denied.log 2>&1; then
    echo "FAIL: $role unexpectedly truncated idempotency table" >&2; exit 1
  fi
done

state="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d dadban_test -c "
SELECT
 (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.case_document_mutation_idempotency'::regclass),
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND tgenabled='O'),
 (SELECT count(*) FROM pg_roles WHERE rolname IN ('dadban_document_runtime_ci','dadban_maintenance_ci') AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb);
")"
if [[ "$state" != "dadban_schema_owner_ci|2|2" ]]; then echo "FAIL: role/trigger catalog state: $state" >&2; exit 1; fi
echo "PASS: schema owner owns tombstones; migration role can change ownership/trigger state (rolled back); runtime and maintenance cannot"
