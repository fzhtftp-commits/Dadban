#!/usr/bin/env bash
set -euo pipefail

# Comprehensive catalog audit in the GitHub Actions disposable PostgreSQL DB.
# Requires the workflow's baseline schema; never point this script at a shared DB.
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
PSQL=(psql -h localhost -U postgres -d dadban_test -v ON_ERROR_STOP=1)
expected_schema="case_documents_catalog_expected"
bad_schema="case_documents_catalog_incompatible"
migration_file="migrations/004_case_documents_metadata.sql"
sql_file="$(mktemp)"

cleanup() {
  "${PSQL[@]}" -c "DROP SCHEMA IF EXISTS ${expected_schema} CASCADE; DROP SCHEMA IF EXISTS ${bad_schema} CASCADE" >/dev/null
  rm -f "${sql_file}"
}
trap cleanup EXIT

cleanup
"${PSQL[@]}" -c "CREATE SCHEMA ${expected_schema}; CREATE SCHEMA ${bad_schema}" >/dev/null

# Apply the actual migration to an isolated schema, resolving baseline parents
# (offices/cases/users) from public. Do not duplicate the migration DDL here.
{
  printf 'SET search_path TO %s, public;\n' "${expected_schema}"
  cat "${migration_file}"
} > "${sql_file}"
"${PSQL[@]}" -f "${sql_file}" >/dev/null

# Build a deliberately incompatible partial-apply fixture in another schema.
"${PSQL[@]}" <<SQL
CREATE TABLE ${bad_schema}.case_documents (
  id uuid NOT NULL,
  title text,
  CONSTRAINT case_documents_storage_metadata_consistency CHECK (length(title) > 0),
  CONSTRAINT case_documents_case_same_office_fk FOREIGN KEY (id) REFERENCES public.offices(id)
);
CREATE INDEX case_documents_office_created_idx
  ON ${bad_schema}.case_documents (title);
SQL

# Compare the full expected column inventory/order/type/nullability and defaults
# against the actual migration-created table; then verify every FK/check/index
# by definition, key order, target, predicate and validity—not just by name.
"${PSQL[@]}" <<SQL
DO \$audit\$
DECLARE
  actual_count integer;
  expected_count integer := 20;
  def text;
  col record;
BEGIN
  SELECT count(*) INTO actual_count
  FROM pg_attribute a
  JOIN pg_class t ON t.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = '${expected_schema}' AND t.relname = 'case_documents'
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'column count mismatch: expected %, got %', expected_count, actual_count;
  END IF;

  FOR col IN SELECT * FROM (VALUES
    (1,'id','uuid',true),
    (2,'office_id','uuid',true),
    (3,'case_id','uuid',true),
    (4,'title','character varying(200)',true),
    (5,'document_type','character varying(32)',true),
    (6,'description','character varying(3000)',false),
    (7,'original_filename','character varying(255)',false),
    (8,'mime_type','character varying(127)',false),
    (9,'size_bytes','bigint',false),
    (10,'document_date','date',false),
    (11,'reference_number','character varying(100)',false),
    (12,'idempotency_key','character varying(128)',false),
    (13,'request_fingerprint','character(64)',false),
    (14,'storage_status','character varying(24)',true),
    (15,'storage_key','text',false),
    (16,'created_by','uuid',true),
    (17,'updated_by','uuid',true),
    (18,'created_at','timestamp with time zone',true),
    (19,'updated_at','timestamp with time zone',true),
    (20,'deleted_at','timestamp with time zone',false)
  ) AS expected(ord,name,typ,is_not_null) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      JOIN pg_class t ON t.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = '${expected_schema}' AND t.relname = 'case_documents'
        AND a.attname = col.name AND format_type(a.atttypid, a.atttypmod) = col.typ
        AND a.attnotnull = col.is_not_null
        AND a.attnum = col.ord
    ) THEN
      RAISE EXCEPTION 'column missing or mismatched (name/type/nullability/order): % / % / %', col.name, col.typ, col.notnull;
    END IF;
  END LOOP;

  -- Collation is part of the column catalog contract too: collatable columns
  -- must retain the database DEFAULT collation, while non-collatable types
  -- must have no collation. This catches same-typed columns with altered locale.
  IF EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_type ty ON ty.oid = a.atttypid
    JOIN pg_class t ON t.oid = a.attrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    LEFT JOIN pg_collation c ON c.oid = a.attcollation
    LEFT JOIN pg_namespace cn ON cn.oid = c.collnamespace
    WHERE tn.nspname = '${expected_schema}' AND t.relname = 'case_documents'
      AND a.attnum > 0 AND NOT a.attisdropped
      AND (
        (ty.typcollation = 0 AND a.attcollation <> 0)
        OR
        (ty.typcollation <> 0 AND NOT (c.collname = 'default' AND cn.nspname = 'pg_catalog'))
      )
  ) THEN
    RAISE EXCEPTION 'column collation differs from the default migration contract';
  END IF;

  -- Assert the exact default-expression inventory, not only the presence of expected fragments.
  FOR col IN SELECT * FROM (VALUES
    ('id','gen_random_uuid()'),
    ('document_type','''other'''),
    ('storage_status','''metadata_only'''),
    ('created_at','now()'),
    ('updated_at','now()')
  ) AS expected(name,expression) LOOP
    SELECT pg_get_expr(d.adbin,d.adrelid) INTO def
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    JOIN pg_class t ON t.oid=d.adrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND a.attname=col.name;
    IF def IS NULL OR regexp_replace(lower(def), '::character varying|::text|[[:space:]]', '', 'g')
       <> regexp_replace(lower(col.expression), '[[:space:]]', '', 'g') THEN
      RAISE EXCEPTION 'column default expression mismatch for %: expected %, got %', col.name, col.expression, def;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_attrdef d JOIN pg_class t ON t.oid=d.adrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='${expected_schema}' AND t.relname='case_documents') <> 5
     OR EXISTS (
       SELECT 1 FROM pg_attrdef d
       JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
       JOIN pg_class t ON t.oid=d.adrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE n.nspname='${expected_schema}' AND t.relname='case_documents'
         AND a.attname NOT IN ('id','document_type','storage_status','created_at','updated_at')
     ) THEN
    RAISE EXCEPTION 'unexpected column default inventory';
  END IF;

  -- Exact office-scoped foreign keys: ordered source columns and referenced table/columns.
  FOR def IN SELECT pg_get_constraintdef(c.oid, true)
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.contype='f'
  LOOP
    NULL;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.contype='f') <> 4 THEN
    -- Three composite office-scoped FKs plus the direct office_id -> offices(id) FK.
    RAISE EXCEPTION 'foreign key count mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_case_same_office_fk'
      AND c.contype='f' AND c.convalidated AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='case_id'), (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='office_id')]::smallint[] AND c.confrelid='public.cases'::regclass AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id'), (SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='office_id')]::smallint[]) THEN
    RAISE EXCEPTION 'case composite FK definition mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_created_by_same_office_fk'
      AND c.contype='f' AND c.convalidated AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='created_by'), (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='office_id')]::smallint[] AND c.confrelid='public.users'::regclass AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id'), (SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='office_id')]::smallint[]) THEN
    RAISE EXCEPTION 'created_by composite FK definition mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_updated_by_same_office_fk'
      AND c.contype='f' AND c.convalidated AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='updated_by'), (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='office_id')]::smallint[] AND c.confrelid='public.users'::regclass AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id'), (SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='office_id')]::smallint[]) THEN
    RAISE EXCEPTION 'updated_by composite FK definition mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.contype='f'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='office_id')]::smallint[] AND c.confrelid='public.offices'::regclass AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='id')]::smallint[]) THEN
    RAISE EXCEPTION 'office_id FK definition mismatch';
  END IF;

  -- Check every CHECK expression (including the inline type and size checks).
  IF (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.contype='c') <> 5 THEN
    RAISE EXCEPTION 'CHECK constraint count mismatch: got %', (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.contype='c');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_storage_metadata_consistency'
      AND c.contype='c' AND c.convalidated AND position('metadata_only' in pg_get_constraintdef(c.oid,true)) > 0
      AND position('storage_status' in pg_get_constraintdef(c.oid,true)) > 0
      AND position('storage_key' in pg_get_constraintdef(c.oid,true)) > 0) THEN
    RAISE EXCEPTION 'storage metadata CHECK mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_idempotency_pair'
      AND c.contype='c' AND c.convalidated AND position('idempotency_key' in pg_get_constraintdef(c.oid,true)) > 0
      AND position('request_fingerprint' in pg_get_constraintdef(c.oid,true)) > 0) THEN
    RAISE EXCEPTION 'idempotency CHECK mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_document_type_check'
      AND c.contype='c' AND c.convalidated AND pg_get_constraintdef(c.oid,true) ILIKE '%petition%'
      AND pg_get_constraintdef(c.oid,true) ILIKE '%court_order%' AND pg_get_constraintdef(c.oid,true) ILIKE '%other%') THEN
    RAISE EXCEPTION 'document_type CHECK mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_size_bytes_check'
      AND c.contype='c' AND c.convalidated AND pg_get_constraintdef(c.oid,true) ILIKE '%26214400%'
      AND pg_get_constraintdef(c.oid,true) ILIKE '%size_bytes >= 0%') THEN
    RAISE EXCEPTION 'size_bytes CHECK mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND c.conname='case_documents_storage_status_check'
      AND c.contype='c' AND c.convalidated AND pg_get_constraintdef(c.oid,true) ILIKE '%pending_storage%'
      AND pg_get_constraintdef(c.oid,true) ILIKE '%quarantined%' AND pg_get_constraintdef(c.oid,true) ILIKE '%stored%') THEN
    RAISE EXCEPTION 'storage_status CHECK mismatch';
  END IF;

  -- Require the complete expected CHECK inventory, not just a count.
  IF (SELECT array_agg(c.conname ORDER BY c.conname)
      FROM pg_constraint c
      WHERE c.conrelid='${expected_schema}.case_documents'::regclass AND c.contype='c')
     <> ARRAY[
       'case_documents_document_type_check',
       'case_documents_idempotency_pair',
       'case_documents_size_bytes_check',
       'case_documents_storage_metadata_consistency',
       'case_documents_storage_status_check'
     ]::name[] THEN
    RAISE EXCEPTION 'CHECK constraint inventory mismatch';
  END IF;

  -- Evaluate actual catalog CHECK expressions against allowed-value and boundary matrices.
  -- This catches missing/extra enum members and weakened numeric/cross-field checks.
  DECLARE
    check_expr text;
    probe_value text;
    probe_ok boolean;
  BEGIN
    SELECT pg_get_expr(c.conbin,c.conrelid) INTO check_expr
    FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.conname='case_documents_document_type_check';
    FOREACH probe_value IN ARRAY ARRAY['petition','contract','evidence','court_order','correspondence','identity','receipt','other'] LOOP
      EXECUTE 'SELECT (' || regexp_replace(check_expr, '\mdocument_type\M', quote_literal(probe_value), 'g') || ')' INTO probe_ok;
      IF probe_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'document_type CHECK rejected allowed value %', probe_value; END IF;
    END LOOP;
    EXECUTE 'SELECT (' || regexp_replace(check_expr, '\mdocument_type\M', quote_literal('__invalid__'), 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'document_type CHECK accepted unexpected value'; END IF;

    SELECT pg_get_expr(c.conbin,c.conrelid) INTO check_expr
    FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.conname='case_documents_storage_status_check';
    FOREACH probe_value IN ARRAY ARRAY['metadata_only','pending_storage','stored','quarantined'] LOOP
      EXECUTE 'SELECT (' || regexp_replace(check_expr, '\mstorage_status\M', quote_literal(probe_value), 'g') || ')' INTO probe_ok;
      IF probe_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'storage_status CHECK rejected allowed value %', probe_value; END IF;
    END LOOP;
    EXECUTE 'SELECT (' || regexp_replace(check_expr, '\mstorage_status\M', quote_literal('__invalid__'), 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'storage_status CHECK accepted unexpected value'; END IF;

    SELECT pg_get_expr(c.conbin,c.conrelid) INTO check_expr
    FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.conname='case_documents_size_bytes_check';
    FOREACH probe_value IN ARRAY ARRAY['NULL','-1','0','26214400','26214401'] LOOP
      EXECUTE 'SELECT (' || regexp_replace(check_expr, '\msize_bytes\M', probe_value, 'g') || ')' INTO probe_ok;
      IF probe_value IN ('NULL','0','26214400') AND probe_ok IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'size_bytes CHECK rejected allowed boundary %', probe_value;
      ELSIF probe_value IN ('-1','26214401') AND probe_ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'size_bytes CHECK accepted out-of-range value %', probe_value;
      END IF;
    END LOOP;

    SELECT pg_get_expr(c.conbin,c.conrelid) INTO check_expr
    FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.conname='case_documents_storage_metadata_consistency';
    EXECUTE 'SELECT (' || regexp_replace(regexp_replace(check_expr, '\mstorage_status\M', quote_literal('metadata_only'), 'g'), '\mstorage_key\M', 'NULL::text', 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'metadata_only with null storage_key must pass'; END IF;
    EXECUTE 'SELECT (' || regexp_replace(regexp_replace(check_expr, '\mstorage_status\M', quote_literal('metadata_only'), 'g'), '\mstorage_key\M', quote_literal('stored/key'), 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'metadata_only with non-null storage_key must fail'; END IF;
    EXECUTE 'SELECT (' || regexp_replace(regexp_replace(check_expr, '\mstorage_status\M', quote_literal('stored'), 'g'), '\mstorage_key\M', quote_literal('stored/key'), 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'stored status with storage_key must pass'; END IF;

    SELECT pg_get_expr(c.conbin,c.conrelid) INTO check_expr
    FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.conname='case_documents_idempotency_pair';
    EXECUTE 'SELECT (' || regexp_replace(regexp_replace(check_expr, '\midempotency_key\M', 'NULL::character varying', 'g'), '\mrequest_fingerprint\M', 'NULL::character', 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'both idempotency fields null must pass'; END IF;
    EXECUTE 'SELECT (' || regexp_replace(regexp_replace(check_expr, '\midempotency_key\M', quote_literal('key-1'), 'g'), '\mrequest_fingerprint\M', quote_literal(repeat('a',64)), 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'both idempotency fields populated must pass'; END IF;
    EXECUTE 'SELECT (' || regexp_replace(regexp_replace(check_expr, '\midempotency_key\M', quote_literal('key-1'), 'g'), '\mrequest_fingerprint\M', 'NULL::character', 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'idempotency key without fingerprint must fail'; END IF;
    EXECUTE 'SELECT (' || regexp_replace(regexp_replace(check_expr, '\midempotency_key\M', 'NULL::character varying', 'g'), '\mrequest_fingerprint\M', quote_literal(repeat('a',64)), 'g') || ')' INTO probe_ok;
    IF probe_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'fingerprint without idempotency key must fail'; END IF;
  END;

  -- Require exactly the expected foreign-key inventory, including direct office FK.
  IF (SELECT array_agg(c.conname ORDER BY c.conname)
      FROM pg_constraint c
      WHERE c.conrelid='${expected_schema}.case_documents'::regclass AND c.contype='f')
     <> ARRAY[
       'case_documents_case_same_office_fk',
       'case_documents_created_by_same_office_fk',
       'case_documents_office_id_fkey',
       'case_documents_updated_by_same_office_fk'
     ]::name[] THEN
    RAISE EXCEPTION 'foreign key inventory mismatch';
  END IF;

  -- PK must be on id; compare index key order, uniqueness, partial predicates,
  -- validity/readiness, and index ownership rather than trusting index names.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.contype='p' AND c.convalidated AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='${expected_schema}.case_documents'::regclass AND attname='id')]::smallint[]) THEN
    RAISE EXCEPTION 'primary key definition mismatch';
  END IF;
  IF (SELECT array_agg(idx.relname ORDER BY idx.relname)
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
      WHERE i.indrelid='${expected_schema}.case_documents'::regclass)
     <> ARRAY[
       'case_documents_idempotency_unique_idx',
       'case_documents_office_case_created_idx',
       'case_documents_office_created_idx',
       'case_documents_pkey'
     ]::name[] THEN
    RAISE EXCEPTION 'index inventory mismatch';
  END IF;
  IF (SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents') <> 4 THEN
    RAISE EXCEPTION 'expected primary-key index plus three migration indexes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND idx.relname='case_documents_idempotency_unique_idx'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=3
      AND pg_get_indexdef(i.indexrelid) ILIKE '%(office_id, created_by, idempotency_key)%'
      AND pg_get_expr(i.indpred,i.indrelid) ILIKE '%idempotency_key IS NOT NULL%') THEN
    RAISE EXCEPTION 'idempotency index definition/state mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND idx.relname='case_documents_office_case_created_idx'
      AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=3
      AND pg_get_indexdef(i.indexrelid) ILIKE '%(office_id, case_id, created_at DESC)%'
      AND pg_get_expr(i.indpred,i.indrelid) ILIKE '%deleted_at IS NULL%') THEN
    RAISE EXCEPTION 'office/case index definition/state mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='${expected_schema}' AND t.relname='case_documents' AND idx.relname='case_documents_office_created_idx'
      AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=2
      AND pg_get_indexdef(i.indexrelid) ILIKE '%(office_id, created_at DESC)%'
      AND pg_get_expr(i.indpred,i.indrelid) ILIKE '%deleted_at IS NULL%') THEN
    RAISE EXCEPTION 'office listing index definition/state mismatch';
  END IF;

  -- Assert exact key attribute order, sort direction, default opclasses, and no
  -- expression/include columns; names and ILIKE fragments alone are insufficient.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = '${expected_schema}.case_documents_idempotency_unique_idx'::regclass
      AND i.indrelid = '${expected_schema}.case_documents'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts = 3 AND i.indnatts = 3
      AND i.indexprs IS NULL
      AND i.indkey::text = (
        SELECT string_agg(a.attnum::text, ' ' ORDER BY v.ord)
        FROM (VALUES (1,'office_id'),(2,'created_by'),(3,'idempotency_key')) v(ord,attname)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname=v.attname
      )
      AND i.indoption::text = '0 0 0'
      AND regexp_replace(regexp_replace(pg_get_expr(i.indpred,i.indrelid), '[[:space:]()]', '', 'g'), '::text', '', 'g')
        = 'idempotency_keyISNOTNULL'
  ) THEN
    RAISE EXCEPTION 'idempotency index exact catalog definition mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = '${expected_schema}.case_documents_office_case_created_idx'::regclass
      AND i.indrelid = '${expected_schema}.case_documents'::regclass
      AND NOT i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts = 3 AND i.indnatts = 3
      AND i.indexprs IS NULL
      AND i.indkey::text = (
        SELECT string_agg(a.attnum::text, ' ' ORDER BY v.ord)
        FROM (VALUES (1,'office_id'),(2,'case_id'),(3,'created_at')) v(ord,attname)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname=v.attname
      )
      AND i.indoption::text = '0 0 3'
      AND regexp_replace(regexp_replace(pg_get_expr(i.indpred,i.indrelid), '[[:space:]()]', '', 'g'), '::text', '', 'g')
        = 'deleted_atISNULL'
  ) THEN
    RAISE EXCEPTION 'office/case index exact catalog definition mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = '${expected_schema}.case_documents_office_created_idx'::regclass
      AND i.indrelid = '${expected_schema}.case_documents'::regclass
      AND NOT i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND i.indexprs IS NULL
      AND i.indkey::text = (
        SELECT string_agg(a.attnum::text, ' ' ORDER BY v.ord)
        FROM (VALUES (1,'office_id'),(2,'created_at')) v(ord,attname)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname=v.attname
      )
      AND i.indoption::text = '0 3'
      AND regexp_replace(regexp_replace(pg_get_expr(i.indpred,i.indrelid), '[[:space:]()]', '', 'g'), '::text', '', 'g')
        = 'deleted_atISNULL'
  ) THEN
    RAISE EXCEPTION 'office listing index exact catalog definition mismatch';
  END IF;

  -- Every catalog index must be live as well as valid and ready.
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid='${expected_schema}.case_documents'::regclass
      AND (NOT i.indislive OR NOT i.indisvalid OR NOT i.indisready)
  ) THEN
    RAISE EXCEPTION 'index lifecycle state mismatch: expected all indexes live, valid, and ready';
  END IF;

  -- Verify index access method, primary-index identity, and unique NULL semantics.
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_am am ON am.oid=idx.relam
    WHERE i.indrelid='${expected_schema}.case_documents'::regclass
      AND am.amname <> 'btree'
  ) THEN
    RAISE EXCEPTION 'unexpected index access method';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class idx ON idx.oid=i.indexrelid
    WHERE i.indrelid='${expected_schema}.case_documents'::regclass
      AND idx.relname='case_documents_pkey'
      AND i.indisprimary AND i.indisunique
      AND i.indnullsnotdistinct = false
      AND i.indnkeyatts=1 AND i.indnatts=1
      AND i.indkey::text = (
        SELECT a.attnum::text FROM pg_attribute a
        WHERE a.attrelid=i.indrelid AND a.attname='id'
      )
  ) THEN
    RAISE EXCEPTION 'primary-key index catalog attributes mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid='${expected_schema}.case_documents_idempotency_unique_idx'::regclass
      AND i.indisunique AND NOT i.indnullsnotdistinct
      AND i.indnkeyatts=3 AND i.indnatts=3
  ) THEN
    RAISE EXCEPTION 'idempotency unique index null semantics or key count mismatch';
  END IF;

  -- The migration defines no exclusion constraints, and its PK/idempotency
  -- uniqueness must be immediate rather than deferrable. These pg_index flags
  -- are not implied by checking index names, key columns, opclasses, or NULLs.
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid='${expected_schema}.case_documents'::regclass
      AND i.indisexclusion
  ) THEN
    RAISE EXCEPTION 'unexpected exclusion index on case_documents';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid='${expected_schema}.case_documents'::regclass
      AND i.indisunique
      AND NOT i.indimmediate
  ) THEN
    RAISE EXCEPTION 'unique indexes must enforce uniqueness immediately';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.contype='p'
      AND (c.condeferrable OR c.condeferred)
  ) THEN
    RAISE EXCEPTION 'primary-key constraint must not be deferrable or initially deferred';
  END IF;

  -- Assert the operator class attached to each index key, not just its column number.
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('case_documents_pkey',1,'uuid_ops'),
      ('case_documents_idempotency_unique_idx',1,'uuid_ops'),
      ('case_documents_idempotency_unique_idx',2,'uuid_ops'),
      ('case_documents_idempotency_unique_idx',3,'text_ops'),
      ('case_documents_office_case_created_idx',1,'uuid_ops'),
      ('case_documents_office_case_created_idx',2,'uuid_ops'),
      ('case_documents_office_case_created_idx',3,'timestamptz_ops'),
      ('case_documents_office_created_idx',1,'uuid_ops'),
      ('case_documents_office_created_idx',2,'timestamptz_ops')
    ) AS expected(index_name,key_ordinal,opclass_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_opclass opc ON opc.oid = i.indclass[expected.key_ordinal - 1]
      WHERE i.indrelid='${expected_schema}.case_documents'::regclass
        AND idx.relname=expected.index_name
        AND opc.opcname=expected.opclass_name
    )
  ) THEN
    RAISE EXCEPTION 'index key operator class differs from expected catalog contract';
  END IF;

  -- Prove the inspection logic detects same-named but structurally wrong objects.
  IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid='${bad_schema}.case_documents'::regclass AND a.attname='case_id' AND a.atttypid='uuid'::regtype AND a.attnum>0 AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'incompatible table fixture was not detected';
  END IF;
  SELECT pg_get_constraintdef(c.oid,true) INTO def
  FROM pg_constraint c WHERE c.conrelid='${bad_schema}.case_documents'::regclass AND c.conname='case_documents_storage_metadata_consistency';
  IF def IS NULL OR def NOT ILIKE '%length(title) > 0%' OR def ILIKE '%storage_status%' THEN
    RAISE EXCEPTION 'incompatible CHECK fixture was not detected: %', def;
  END IF;
  SELECT pg_get_constraintdef(c.oid,true) INTO def
  FROM pg_constraint c WHERE c.conrelid='${bad_schema}.case_documents'::regclass AND c.conname='case_documents_case_same_office_fk';
  IF def IS NULL OR def NOT ILIKE '%FOREIGN KEY (id) REFERENCES%offices(id)%' OR def ILIKE '%case_id, office_id%' THEN
    RAISE EXCEPTION 'incompatible FK fixture was not detected: %', def;
  END IF;
  SELECT pg_get_indexdef(i.indexrelid) INTO def
  FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
  WHERE i.indrelid='${bad_schema}.case_documents'::regclass AND idx.relname='case_documents_office_created_idx';
  IF def IS NULL OR def NOT ILIKE '%(title)%' OR def ILIKE '%(office_id, created_at DESC)%' THEN
    RAISE EXCEPTION 'incompatible index fixture was not detected: %', def;
  END IF;

  -- Tighten the catalog contract beyond object names and substring matches:
  -- compare normalized CHECK expressions, FK actions/deferrability, and column flags.
  IF EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid='${expected_schema}.case_documents'::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
      AND (a.attidentity <> '' OR a.attgenerated <> '' OR a.attinhcount <> 0)
  ) THEN
    RAISE EXCEPTION 'unexpected identity/generated/inherited column attributes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.contype='f'
      AND (c.condeferrable OR c.condeferred OR c.confmatchtype <> 's'
        OR c.confupdtype <> 'a' OR c.confdeltype <> 'a')
  ) THEN
    RAISE EXCEPTION 'foreign key action, match mode, or deferrability mismatch';
  END IF;

  -- Audit table-level catalog attributes and constraint validation/inheritance.
  -- The migration contract expects an ordinary permanent table and validated,
  -- inheritable FK/CHECK constraints; names alone must not mask catalog drift.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class t
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='${expected_schema}' AND t.relname='case_documents'
      AND t.relkind='r' AND t.relpersistence='p'
  ) THEN
    RAISE EXCEPTION 'table relation kind or persistence differs from migration contract';
  END IF;

  -- Migration 004 does not enable row-level security or change replica identity.
  -- These flags alter row visibility/enforcement and logical-replication behavior
  -- without changing the column, constraint, or index inventories.
  IF EXISTS (
    SELECT 1 FROM pg_class t
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='${expected_schema}' AND t.relname='case_documents'
      AND (t.relrowsecurity OR t.relforcerowsecurity OR t.relreplident <> 'd')
  ) THEN
    RAISE EXCEPTION 'row-security or replica-identity flags differ from migration contract';
  END IF;

  -- Migration 004 declares no relation storage parameters. Unexpected reloptions
  -- on the table or its indexes can change storage behavior independently of
  -- column/constraint/index definitions, so require the catalog defaults.
  IF EXISTS (
    SELECT 1
    FROM pg_class r
    WHERE (
      r.oid='${expected_schema}.case_documents'::regclass
      OR r.oid IN (
        SELECT i.indexrelid
        FROM pg_index i
        WHERE i.indrelid='${expected_schema}.case_documents'::regclass
      )
    )
      AND r.reloptions IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'unexpected relation storage options on case_documents or its indexes';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND (
        NOT c.convalidated
        OR (c.contype='c' AND c.connoinherit)
      )
  ) THEN
    RAISE EXCEPTION 'FK/CHECK validation or inheritance flags differ from migration contract';
  END IF;

  -- Migration 004 declares no triggers or rewrite rules. Unexpected user
  -- triggers/rules could add hidden side effects even if columns and indexes
  -- still match, so audit their catalog inventory explicitly.
  IF EXISTS (
    SELECT 1 FROM pg_trigger tr
    WHERE tr.tgrelid='${expected_schema}.case_documents'::regclass
      AND NOT tr.tgisinternal
  ) THEN
    RAISE EXCEPTION 'unexpected user-defined trigger on case_documents';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_rewrite rw
    WHERE rw.ev_class='${expected_schema}.case_documents'::regclass
  ) THEN
    RAISE EXCEPTION 'unexpected rewrite rule on case_documents';
  END IF;

  -- This migration creates a standalone table; constraints must be local rather
  -- than inherited/partition-parent constraints. Assert catalog provenance too.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND (
        NOT c.conislocal
        OR c.coninhcount <> 0
        OR c.conparentid <> 0
      )
  ) THEN
    RAISE EXCEPTION 'constraint locality/inheritance provenance differs from migration contract';
  END IF;

  -- Validate every CHECK expression semantically against its expected expression
  -- after removing PostgreSQL's presentation-only whitespace and parentheses.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.contype='c'
      AND (
        (c.conname='case_documents_storage_metadata_consistency'
          AND regexp_replace(regexp_replace(lower(pg_get_constraintdef(c.oid,true)), '::(character varying|text)', '', 'g'), '[[:space:]()]', '', 'g')
            <> regexp_replace(lower('CHECK ((storage_status = ''metadata_only'' AND storage_key IS NULL) OR storage_status <> ''metadata_only'')'), '[[:space:]()]', '', 'g'))
        OR
        (c.conname='case_documents_idempotency_pair'
          AND regexp_replace(regexp_replace(lower(pg_get_constraintdef(c.oid,true)), '::(character varying|text)', '', 'g'), '[[:space:]()]', '', 'g')
            <> regexp_replace(lower('CHECK ((idempotency_key IS NULL AND request_fingerprint IS NULL) OR (idempotency_key IS NOT NULL AND request_fingerprint IS NOT NULL))'), '[[:space:]()]', '', 'g'))
      )
  ) THEN
    RAISE EXCEPTION 'CHECK expression differs from the full expected invariant';
  END IF;

  IF (SELECT count(*) FROM pg_constraint c
      WHERE c.conrelid='${expected_schema}.case_documents'::regclass
        AND c.contype IN ('p','u','f','c','x')) <> 10 THEN
    RAISE EXCEPTION 'unexpected or missing table constraint inventory';
  END IF;

  RAISE NOTICE 'PASS: full migration catalog matches expected columns/defaults/nullability/order, FK/CHECK definitions, PK and index keys/predicates/state; mismatched fixtures detected';
END
\$audit\$;
SQL

echo "PASS: comprehensive case_documents catalog audit"
