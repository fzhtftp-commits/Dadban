#!/usr/bin/env bash
set -euo pipefail

# Negative index test: use only the disposable PostgreSQL service.
# Execute the exact named CREATE INDEX statement from migration 004 against a
# deliberately wrong same-named index, and treat PostgreSQL's rejection as pass.
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
PSQL=(psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1)
probe_schema="case_documents_wrong_index_probe"
sql_file="$(mktemp)"

cleanup() {
  "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS ${probe_schema} CASCADE" >/dev/null
  rm -f "${sql_file}"
}
trap cleanup EXIT

cleanup
"${PSQL[@]}" -c "CREATE SCHEMA ${probe_schema}; CREATE TABLE ${probe_schema}.case_documents (id integer, office_id uuid, created_at timestamptz, deleted_at timestamptz, title text)" >/dev/null

# Create an incompatible same-named index (title only) in the isolated schema.
"${PSQL[@]}" -c "CREATE INDEX case_documents_office_created_idx ON ${probe_schema}.case_documents (title)" >/dev/null

# Pull the actual one-line CREATE INDEX statement from migration 004; don't
# retype its intended definition in this test. Fail closed if it is absent/ambiguous.
matches="$(grep -Ec '^create index case_documents_office_created_idx ' migrations/004_case_documents_metadata.sql || true)"
if [[ "$matches" != "1" ]]; then
  echo "FAIL: expected exactly one CREATE INDEX statement for case_documents_office_created_idx; found $matches"
  exit 1
fi
{
  printf 'SET search_path TO %s, public;\n' "$probe_schema"
  grep '^create index case_documents_office_created_idx ' migrations/004_case_documents_metadata.sql
} > "$sql_file"

if "${PSQL[@]}" -f "$sql_file"; then
  echo "FAIL: migration index statement unexpectedly accepted an incompatible same-named index"
  exit 1
else
  echo "PASS: migration index statement failed as expected on an incompatible same-named index"
fi
