#!/usr/bin/env bash
set -euo pipefail
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then
  echo "Refusing backup/restore test against non-local PostgreSQL" >&2; exit 2
fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then
  echo "Refusing backup/restore test outside dadban_test" >&2; exit 2
fi
backup=/tmp/dadban-tombstone-backup.dump
restore_db=dadban_tombstone_restore_test
export PGPASSWORD=postgres
cleanup() {
  dropdb -h localhost -U postgres --if-exists "$restore_db" >/dev/null 2>&1 || true
  rm -f "$backup"
}
trap cleanup EXIT

before="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d dadban_test -c "
SELECT
 (SELECT count(*) FROM public.case_document_mutation_idempotency),
 (SELECT count(*) FROM public.audit_logs),
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal);
")"
echo "BACKUP SOURCE DB ASSERTIONS: idempotency_rows,audit_rows,tombstone_triggers=$before"

pg_dump -h localhost -U postgres -Fc -d dadban_test -f "$backup"
createdb -h localhost -U postgres "$restore_db"
pg_restore -h localhost -U postgres --no-owner --role=postgres -d "$restore_db" "$backup"

after="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$restore_db" -c "
SELECT
 (SELECT count(*) FROM public.case_document_mutation_idempotency),
 (SELECT count(*) FROM public.audit_logs),
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal);
")"
if [[ "$before" != "$after" ]]; then
  echo "FAIL: restore counts/trigger state differ: before=$before after=$after" >&2; exit 1
fi
echo "RESTORED DB ASSERTIONS: idempotency_rows,audit_rows,tombstone_triggers=$after"

# Migration 007 must not be re-applied over a restored DB; failure must leave
# the restored protection/catalog intact.
if psql -h localhost -U postgres -d "$restore_db" -v ON_ERROR_STOP=1 -f migrations/007_case_document_mutation_tombstones.sql >/tmp/dadban-restored-migration-rerun.log 2>&1; then
  echo "FAIL: migration 007 unexpectedly succeeded after restore" >&2; exit 1
fi
post="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d "$restore_db" -c "
SELECT
 (SELECT count(*) FROM pg_attribute WHERE attrelid='public.case_document_mutation_idempotency'::regclass AND attname='purged_at' AND NOT attisdropped),
 (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal),
 (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='case_document_mutation_idempotency' AND indexname='case_document_mutation_idempotency_purged_at_idx');
")"
if [[ "$post" != "1|2|1" ]]; then
 echo "FAIL: restored schema protection changed after migration rerun failure: $post" >&2; exit 1
fi
echo "PASS: PostgreSQL backup/restore preserves idempotency and audit counts; migration 007 re-run after restore fails without losing tombstone protections"
