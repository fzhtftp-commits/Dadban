#!/usr/bin/env bash
set -euo pipefail
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
HOST=localhost
DB=dadban_rollback_test
PSQL=(psql -h "$HOST" -U postgres -d "$DB" -v ON_ERROR_STOP=1)
dropdb -h "$HOST" -U postgres --if-exists "$DB"
createdb -h "$HOST" -U postgres "$DB"
trap 'dropdb -h "$HOST" -U postgres --if-exists "$DB"' EXIT
psql -h "$HOST" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f ../database/schema.sql
tmp="$(mktemp)"
trap 'rm -f "$tmp"; dropdb -h "$HOST" -U postgres --if-exists "$DB"' EXIT
awk '/^COMMIT;[[:space:]]*$/ { print "SELECT 1 / 0;"; } { print; }' migrations/004_case_documents_metadata.sql > "$tmp"
if "${PSQL[@]}" -f "$tmp"; then
  echo "FAIL: broken migration unexpectedly committed" >&2
  exit 1
fi
result="$("${PSQL[@]}" -Atqc "SELECT to_regclass('public.case_documents') IS NULL AND to_regclass('public.case_documents_idempotency_unique_idx') IS NULL")"
if [ "$result" = "t" ]; then
  echo "PASS: failed migration rolled back all DDL"
else
  echo "FAIL: failed migration left partial DDL" >&2
  exit 1
fi
