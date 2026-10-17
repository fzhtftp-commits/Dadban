#!/usr/bin/env bash
set -euo pipefail

# CI only: this test must never target a non-local or non-disposable database.
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then
  echo "Refusing migration rerun test against non-local PostgreSQL" >&2
  exit 2
fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then
  echo "Refusing migration rerun test outside dadban_test" >&2
  exit 2
fi

if psql -h localhost -U postgres -v ON_ERROR_STOP=1 -d dadban_test -f migrations/007_case_document_mutation_tombstones.sql >/tmp/dadban-tombstone-rerun.log 2>&1; then
  echo "FAIL: migration 007 unexpectedly succeeded on second application" >&2
  exit 1
fi

state="$(psql -h localhost -U postgres -X -A -t -v ON_ERROR_STOP=1 -d dadban_test -c "
SELECT
  (SELECT count(*) FROM pg_attribute WHERE attrelid='public.case_document_mutation_idempotency'::regclass AND attname='purged_at' AND NOT attisdropped),
  (SELECT count(*) FROM pg_constraint WHERE conrelid='public.case_document_mutation_idempotency'::regclass AND conname='case_document_mutation_idempotency_purged_completed_check'),
  (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.case_document_mutation_idempotency'::regclass AND tgname IN ('case_document_mutation_idempotency_no_delete','case_document_mutation_idempotency_identity_immutable') AND NOT tgisinternal),
  (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='case_document_mutation_idempotency' AND indexname='case_document_mutation_idempotency_purged_at_idx');
")"
if [[ "$state" != "1|1|2|1" ]]; then
  echo "FAIL: migration rerun left unexpected catalog state: $state" >&2
  cat /tmp/dadban-tombstone-rerun.log >&2
  exit 1
fi

echo "PASS: migration 007 second application fails atomically; existing tombstone column, constraint, triggers, and index remain intact"
