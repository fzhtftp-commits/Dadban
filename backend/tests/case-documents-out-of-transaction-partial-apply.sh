#!/usr/bin/env bash
set -euo pipefail

# Demonstrate the partial-apply risk when migration 004 is run without an
# explicit transaction. This runs only on the disposable CI PostgreSQL service.
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
PSQL=(psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1)
probe_schema="case_documents_out_of_tx_probe"
sql_file="$(mktemp)"

cleanup() {
  "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS ${probe_schema} CASCADE" >/dev/null
  rm -f "${sql_file}"
}
trap cleanup EXIT

cleanup
"${PSQL[@]}" -c "CREATE SCHEMA ${probe_schema}; CREATE TABLE ${probe_schema}.conflict_target (id integer); CREATE INDEX case_documents_idempotency_unique_idx ON ${probe_schema}.conflict_target (id)" >/dev/null

# Deliberately omit BEGIN/COMMIT. The migration should create its table, then
# fail at its first index because that index name is already occupied in the
# probe schema. psql's expected nonzero exit is caught below.
{
  printf 'SET search_path TO %s, public;\n' "$probe_schema"
  cat migrations/004_case_documents_metadata.sql
} > "$sql_file"

if "${PSQL[@]}" -f "$sql_file"; then
  echo "FAIL: migration unexpectedly succeeded despite the conflicting index"
  exit 1
else
  echo "PASS: migration failed as expected at the conflicting index without a transaction"
fi

table_exists="$("${PSQL[@]}" -Atc "SELECT to_regclass('${probe_schema}.case_documents') IS NOT NULL")"
if [[ "$table_exists" != "t" ]]; then
  echo "FAIL: expected partial-apply evidence (case_documents table) was not found"
  exit 1
fi

first_index_on_documents="$("${PSQL[@]}" -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='${probe_schema}' AND tablename='case_documents' AND indexname IN ('case_documents_idempotency_unique_idx','case_documents_office_case_created_idx','case_documents_office_created_idx')")"
if [[ "$first_index_on_documents" != "0" ]]; then
  echo "FAIL: unexpected document indexes exist after first-index conflict"
  exit 1
fi

conflict_index_preserved="$("${PSQL[@]}" -Atc "SELECT count(*) FROM pg_indexes WHERE schemaname='${probe_schema}' AND tablename='conflict_target' AND indexname='case_documents_idempotency_unique_idx'")"
if [[ "$conflict_index_preserved" != "1" ]]; then
  echo "FAIL: conflicting probe index was not preserved as expected"
  exit 1
fi

echo "PASS: out-of-transaction failure leaves the created table behind; test cleanup removes only the probe schema"
