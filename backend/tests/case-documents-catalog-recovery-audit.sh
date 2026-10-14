#!/usr/bin/env bash
set -euo pipefail

# Exercise the recovery runbook's catalog-detection logic against deliberately
# incompatible objects in a disposable PostgreSQL schema only.
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
PSQL=(psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1)
probe_schema="case_documents_catalog_audit_probe"

cleanup() {
  "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS ${probe_schema} CASCADE" >/dev/null
}
trap cleanup EXIT

cleanup
"${PSQL[@]}" -c "CREATE SCHEMA ${probe_schema}" >/dev/null

# Same table name, but wrong columns; same constraint name, wrong expression;
# same index name, wrong indexed column. This models a partial/incompatible apply.
"${PSQL[@]}" <<SQL
CREATE TABLE ${probe_schema}.case_documents (
  id integer NOT NULL,
  title text,
  CONSTRAINT case_documents_storage_metadata_consistency CHECK (id > 0)
);
CREATE INDEX case_documents_office_created_idx
  ON ${probe_schema}.case_documents (title);
SQL

# These assertions query PostgreSQL catalogs rather than trusting object names.
# A zero exit means the inspection can distinguish all three mismatches.
"${PSQL[@]}" <<SQL
DO \$audit\$
DECLARE
  table_has_expected_case_id boolean;
  constraint_definition text;
  index_definition text;
  index_is_valid boolean;
  index_is_ready boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = '${probe_schema}'
      AND c.relname = 'case_documents'
      AND a.attname = 'case_id'
      AND a.atttypid = 'uuid'::regtype
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) INTO table_has_expected_case_id;

  IF table_has_expected_case_id THEN
    RAISE EXCEPTION 'catalog audit missed incompatible table columns';
  END IF;

  SELECT pg_get_constraintdef(con.oid, true)
    INTO constraint_definition
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = '${probe_schema}'
    AND c.relname = 'case_documents'
    AND con.conname = 'case_documents_storage_metadata_consistency';

  IF constraint_definition IS NULL OR constraint_definition NOT LIKE '%id > 0%' THEN
    RAISE EXCEPTION 'catalog audit failed to identify the mismatched constraint definition: %', constraint_definition;
  END IF;

  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready
    INTO index_definition, index_is_valid, index_is_ready
  FROM pg_index i
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = idx.relnamespace
  WHERE n.nspname = '${probe_schema}'
    AND idx.relname = 'case_documents_office_created_idx';

  IF index_definition IS NULL OR index_definition NOT LIKE '%(title)%' THEN
    RAISE EXCEPTION 'catalog audit failed to identify the mismatched index definition: %', index_definition;
  END IF;

  IF NOT index_is_valid OR NOT index_is_ready THEN
    RAISE EXCEPTION 'fixture index unexpectedly invalid/not-ready; expected a valid wrong-definition index';
  END IF;

  RAISE NOTICE 'PASS: catalog audit detected missing expected table column, mismatched same-named constraint, and mismatched same-named index';
END
\$audit\$;
SQL

echo "PASS: catalog recovery audit detected all three deliberately incompatible objects"
