\set ON_ERROR_STOP on

-- Run after migrations 006/007 in disposable dadban_test. Never use production.
DO $owner$
DECLARE
  table_owner name;
BEGIN
  SELECT r.rolname INTO table_owner
  FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
  WHERE c.oid='public.case_document_mutation_idempotency'::regclass;

  IF table_owner IS NULL THEN
    RAISE EXCEPTION 'could not resolve idempotency table owner';
  END IF;
  IF table_owner = 'dadban_document_runtime_ci' THEN
    RAISE EXCEPTION 'runtime role owns idempotency table and can disable triggers';
  END IF;
  IF has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','TRIGGER')
     OR has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','TRUNCATE')
     OR has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','DELETE')
     OR has_table_privilege('dadban_document_runtime_ci','public.case_document_mutation_idempotency','UPDATE') THEN
    RAISE EXCEPTION 'runtime role has table-level privileges that can weaken tombstone guarantees';
  END IF;
  RAISE NOTICE 'PASS: table owner is %, distinct from runtime; runtime cannot DELETE, UPDATE table-wide, TRUNCATE, or manage triggers', table_owner;
END
$owner$;

-- Confirm the runtime role cannot alter table ownership or disable triggers:
DO $runtime_ddl$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    EXECUTE 'SET LOCAL ROLE dadban_document_runtime_ci';
    EXECUTE 'ALTER TABLE public.case_document_mutation_idempotency DISABLE TRIGGER ALL';
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege OR feature_not_supported THEN
    denied := true;
    EXECUTE 'RESET ROLE';
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'runtime unexpectedly disabled tombstone triggers';
  END IF;
  RAISE NOTICE 'PASS: runtime ALTER TABLE DISABLE TRIGGER ALL is denied';
END
$runtime_ddl$;
