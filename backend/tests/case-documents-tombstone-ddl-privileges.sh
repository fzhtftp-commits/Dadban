#!/usr/bin/env bash
set -euo pipefail
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then
  echo "Refusing tombstone privilege tests against non-local PostgreSQL" >&2; exit 2
fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then
  echo "Refusing tombstone privilege tests outside dadban_test" >&2; exit 2
fi
expect_denied() {
  label="$1"; shift
  if psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1 -c "SET ROLE dadban_document_runtime_ci; $*" >/tmp/dadban-runtime-denied.log 2>&1; then
    echo "FAIL: runtime unexpectedly allowed: $label" >&2; exit 1
  fi
  echo "PASS: runtime denied: $label"
}
expect_denied "ALTER TABLE DISABLE TRIGGER ALL" "ALTER TABLE public.case_document_mutation_idempotency DISABLE TRIGGER ALL"
expect_denied "TRUNCATE idempotency table" "TRUNCATE public.case_document_mutation_idempotency"
expect_denied "UPDATE purged_at" "UPDATE public.case_document_mutation_idempotency SET purged_at=NULL"
expect_denied "DELETE idempotency identity" "DELETE FROM public.case_document_mutation_idempotency"

state="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d dadban_test -c "
SELECT
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal),
 (SELECT count(*) FROM pg_roles WHERE rolname='dadban_document_runtime_ci' AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb),
 (SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.case_document_mutation_idempotency'::regclass AND r.rolname <> 'dadban_document_runtime_ci');
")"
if [[ "$state" != "2|1|1" ]]; then
 echo "FAIL: trigger/runtime/owner catalog assertions failed: $state" >&2; exit 1
fi
echo "PASS: two tombstone triggers remain enabled; runtime is non-admin and not table owner"
