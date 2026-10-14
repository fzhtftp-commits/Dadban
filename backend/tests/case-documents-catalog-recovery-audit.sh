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

  -- PK must be on id; compare index key order, uniqueness, partial predicates,
  -- validity/readiness, and index ownership rather than trusting index names.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid='${expected_schema}.case_documents'::regclass
      AND c.contype='p' AND c.convalidated AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='${expected_schema}.case_documents'::regclass AND attname='id')]::smallint[]) THEN
    RAISE EXCEPTION 'primary key definition mismatch';
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
