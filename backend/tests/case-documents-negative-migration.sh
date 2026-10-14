#!/usr/bin/env bash
set -euo pipefail

# Negative migration test: run only against the disposable PostgreSQL service.
# A deliberately incompatible same-named table must make migration 004 fail.
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
PSQL=(psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1)
probe_schema="case_documents_wrong_table_probe"

cleanup() {
  "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS ${probe_schema} CASCADE" >/dev/null
}
trap cleanup EXIT

cleanup
"${PSQL[@]}" -c "CREATE SCHEMA ${probe_schema}; CREATE TABLE ${probe_schema}.case_documents (id integer)" >/dev/null

if "${PSQL[@]}" -c "SET search_path TO ${probe_schema}, public" -f migrations/004_case_documents_metadata.sql; then
  echo "FAIL: migration 004 unexpectedly accepted a same-named incompatible table"
  exit 1
else
  echo "PASS: migration 004 failed as expected on a same-named incompatible table"
fi
