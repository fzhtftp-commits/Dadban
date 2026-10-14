#!/usr/bin/env bash
set -euo pipefail

# Force an uncaught SQL error after migration 004 has created its table and
# indexes. The migration statements run inside an explicit transaction in an
# isolated schema on the disposable PostgreSQL service only.
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
PSQL=(psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1)
probe_schema="case_documents_forced_rollback_probe"
sql_file="$(mktemp)"

cleanup() {
  "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS ${probe_schema} CASCADE" >/dev/null
  rm -f "${sql_file}"
}
trap cleanup EXIT

cleanup
"${PSQL[@]}" -c "CREATE SCHEMA ${probe_schema}" >/dev/null

{
  printf 'BEGIN;\nSET LOCAL search_path TO %s, public;\n' "$probe_schema"
  cat migrations/004_case_documents_metadata.sql
  # Deliberately uncaught failure after all migration DDL has run.
  printf '\nSELECT 1 / 0;\n'
} > "$sql_file"

if "${PSQL[@]}" -f "$sql_file"; then
  echo "FAIL: forced post-migration error unexpectedly returned success"
  exit 1
else
  echo "PASS: PostgreSQL rejected the forced post-migration statement as expected"
fi

# psql exits with an open transaction after ON_ERROR_STOP; PostgreSQL must
# roll back the whole connection transaction, including the migration DDL.
if "${PSQL[@]}" -Atc "SELECT to_regclass('${probe_schema}.case_documents') IS NULL"; then
  table_absent="$("${PSQL[@]}" -Atc "SELECT to_regclass('${probe_schema}.case_documents') IS NULL")"
else
  echo "FAIL: unable to inspect probe schema after expected failure"
  exit 1
fi
if [[ "$table_absent" != "t" ]]; then
  echo "FAIL: case_documents table remains after the failed transaction"
  exit 1
fi

remaining_indexes="$("${PSQL[@]}" -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname = '${probe_schema}' AND indexname IN ('case_documents_idempotency_unique_idx','case_documents_office_case_created_idx','case_documents_office_created_idx')")"
if [[ "$remaining_indexes" != "0" ]]; then
  echo "FAIL: one or more migration indexes remain after the failed transaction"
  exit 1
fi

remaining_constraints="$("${PSQL[@]}" -Atc "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = '${probe_schema}' AND t.relname = 'case_documents'")"
if [[ "$remaining_constraints" != "0" ]]; then
  echo "FAIL: one or more migration constraints remain after the failed transaction"
  exit 1
fi

echo "PASS: forced failure rolled back the migration table, indexes, and constraints"
