\set ON_ERROR_STOP on
-- Runs only against the disposable dadban_test database after migrations 006/007.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_ci') THEN
    CREATE ROLE dadban_document_runtime_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$role$;

ALTER ROLE dadban_document_runtime_ci NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA public TO dadban_document_runtime_ci;
REVOKE ALL ON public.case_document_mutation_idempotency FROM dadban_document_runtime_ci;
GRANT SELECT, INSERT ON public.case_document_mutation_idempotency TO dadban_document_runtime_ci;
GRANT UPDATE (response_status) ON public.case_document_mutation_idempotency TO dadban_document_runtime_ci;

DO $privileges$
BEGIN
  IF NOT has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','SELECT')
     OR NOT has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','INSERT')
     OR NOT has_column_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','response_status','UPDATE') THEN
    RAISE EXCEPTION 'runtime role is missing required idempotency read/reservation/completion privileges';
  END IF;
  IF has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','DELETE')
     OR has_column_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','purged_at','UPDATE')
     OR has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','TRUNCATE')
     OR (SELECT rolsuper OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname='dadban_document_runtime_ci') THEN
    RAISE EXCEPTION 'runtime role can bypass durable tombstone retention';
  END IF;
END
$privileges$;

-- A second application of migration 007 must fail atomically rather than
-- partially alter the schema. This harness runs it separately and verifies catalog.
