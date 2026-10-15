\set ON_ERROR_STOP on
-- Fresh upgrade rehearsal. This file is run only against workflow disposable PostgreSQL.
\ir ../../database/schema.sql
\ir ../../database/migrations/20261010_office_isolation_constraints.sql
\ir ../../database/migrations/20261014_case_actions.sql
\ir ../migrations/004_case_documents_metadata.sql
\ir ../migrations/005_shared_rate_limits.sql
\ir ../migrations/006_case_document_mutation_idempotency.sql
\ir ../migrations/007_case_document_mutation_tombstones.sql

DO $catalog$
DECLARE cols text[]; status_check text; constraint_names text[];
BEGIN
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO cols
  FROM pg_attribute a WHERE a.attrelid='public.case_documents'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM ARRAY[
    'id','office_id','case_id','title','document_type','description','original_filename','mime_type',
    'size_bytes','document_date','reference_number','confidentiality','idempotency_key','request_fingerprint',
    'storage_status','created_by','updated_by','created_at','updated_at','deleted_at'
  ]::text[] THEN RAISE EXCEPTION 'Unexpected case_documents column inventory: %', cols; END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.case_documents'::regclass AND attname='storage_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'storage_key must not exist in metadata-only schema';
  END IF;
  SELECT pg_get_constraintdef(c.oid,true) INTO status_check
  FROM pg_constraint c WHERE c.conrelid='public.case_documents'::regclass AND c.contype='c'
    AND pg_get_constraintdef(c.oid,true) LIKE '%storage_status%';
  IF status_check IS NULL OR status_check NOT LIKE '%metadata_only%' OR status_check LIKE '%stored%'
     OR status_check LIKE '%pending_storage%' OR status_check LIKE '%quarantined%' THEN
    RAISE EXCEPTION 'storage_status must allow only metadata_only, found: %', status_check;
  END IF;
  SELECT array_agg(conname::text ORDER BY conname) INTO constraint_names
  FROM pg_constraint WHERE conrelid='public.case_documents'::regclass;
  IF NOT (constraint_names @> ARRAY[
    'case_documents_case_same_office_fk','case_documents_created_by_same_office_fk',
    'case_documents_updated_by_same_office_fk','case_documents_idempotency_pair'
  ]::text[]) THEN RAISE EXCEPTION 'Missing required constraints: %', constraint_names; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    WHERE i.indrelid='public.users'::regclass AND ix.relname='users_id_office_unique'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=2
      AND pg_get_indexdef(i.indexrelid) ILIKE '%(id, office_id)%'
  ) THEN RAISE EXCEPTION 'users(id, office_id) prerequisite is not a valid exact unique index'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    WHERE i.indrelid='public.cases'::regclass AND ix.relname='cases_id_office_unique'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=2
      AND pg_get_indexdef(i.indexrelid) ILIKE '%(id, office_id)%'
  ) THEN RAISE EXCEPTION 'cases(id, office_id) prerequisite is not a valid exact unique index'; END IF;
END
$catalog$;


-- Verify real catalog mappings/definitions, not just constraint/index names.
DO $document_catalog$
DECLARE
  fk record;
  fk_count integer;
  check_count integer;
  index_keys text[];
  index_predicate text;
  index_definition text;
  check_def text;
  required_check text;
BEGIN
  -- Column names alone are insufficient: enforce the expected SQL types and nullability too.
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('id','uuid',true),
      ('office_id','uuid',true),
      ('case_id','uuid',true),
      ('title','character varying(200)',true),
      ('document_type','character varying(32)',true),
      ('description','character varying(3000)',false),
      ('original_filename','character varying(255)',false),
      ('mime_type','character varying(127)',false),
      ('size_bytes','bigint',false),
      ('document_date','date',false),
      ('reference_number','character varying(120)',false),
      ('confidentiality','character varying(16)',true),
      ('idempotency_key','character varying(128)',false),
      ('request_fingerprint','character(64)',false),
      ('storage_status','character varying(24)',true),
      ('created_by','uuid',true),
      ('updated_by','uuid',true),
      ('created_at','timestamp with time zone',true),
      ('updated_at','timestamp with time zone',true),
      ('deleted_at','timestamp with time zone',false)
    ) AS expected(name,sql_type,is_not_null)
    LEFT JOIN pg_attribute a
      ON a.attrelid='public.case_documents'::regclass AND a.attname=expected.name AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attname IS NULL
       OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM expected.sql_type
       OR a.attnotnull IS DISTINCT FROM expected.is_not_null
  ) THEN
    RAISE EXCEPTION 'case_documents column type/nullability catalog differs from contract';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.case_documents'::regclass AND a.attname='id'
      AND pg_get_expr(d.adbin,d.adrelid) LIKE '%gen_random_uuid%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.case_documents'::regclass AND a.attname='storage_status'
      AND pg_get_expr(d.adbin,d.adrelid) LIKE '%metadata_only%'
  ) THEN
    RAISE EXCEPTION 'Required id/storage_status column defaults are missing or changed';
  END IF;

  SELECT count(*) INTO fk_count
  FROM pg_constraint c
  WHERE c.conrelid='public.case_documents'::regclass AND c.contype='f' AND c.convalidated;
  IF fk_count <> 4 THEN
    RAISE EXCEPTION 'Expected four validated foreign keys, found %', fk_count;
  END IF;

  -- Each FK must map the intended source columns to the intended target columns.
  FOR fk IN
    SELECT c.conname,
           c.confrelid::regclass::text AS target_table,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord)
                 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
                 ORDER BY k.ord) AS source_columns,
           ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord)
                 JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum
                 ORDER BY k.ord) AS target_columns,
           c.convalidated, c.confdeltype
    FROM pg_constraint c
    WHERE c.conrelid='public.case_documents'::regclass AND c.contype='f'
  LOOP
    IF NOT fk.convalidated OR fk.confdeltype <> 'r' THEN
      RAISE EXCEPTION 'FK % must be validated and RESTRICT deletes', fk.conname;
    END IF;
    IF NOT (
      (fk.target_table='offices' AND fk.source_columns=ARRAY['office_id']::text[] AND fk.target_columns=ARRAY['id']::text[])
      OR (fk.target_table='cases' AND fk.source_columns=ARRAY['case_id','office_id']::text[] AND fk.target_columns=ARRAY['id','office_id']::text[])
      OR (fk.target_table='users' AND fk.source_columns=ARRAY['created_by','office_id']::text[] AND fk.target_columns=ARRAY['id','office_id']::text[])
      OR (fk.target_table='users' AND fk.source_columns=ARRAY['updated_by','office_id']::text[] AND fk.target_columns=ARRAY['id','office_id']::text[])
    ) THEN
      RAISE EXCEPTION 'Unexpected FK definition %: % -> % (%)', fk.conname, fk.source_columns, fk.target_table, fk.target_columns;
    END IF;
  END LOOP;

  -- Check constraints must be validated and encode the actual intended bounds/allowlists.
  SELECT count(*) INTO check_count
  FROM pg_constraint c
  WHERE c.conrelid='public.case_documents'::regclass AND c.contype='c' AND c.convalidated;
  IF check_count <> 8 THEN
    RAISE EXCEPTION 'Expected eight validated CHECK constraints, found %', check_count;
  END IF;
  FOR required_check IN SELECT unnest(ARRAY[
    'title','document_type','description','size_bytes','reference_number',
    'confidentiality','storage_status','idempotency_pair'
  ]) LOOP
    SELECT pg_get_constraintdef(c.oid,true) INTO check_def
    FROM pg_constraint c
    WHERE c.conrelid='public.case_documents'::regclass AND c.contype='c'
      AND c.convalidated AND c.conname LIKE '%' || required_check || '%';
    IF check_def IS NULL THEN
      RAISE EXCEPTION 'Missing validated CHECK for %', required_check;
    END IF;
    IF required_check='title' AND (check_def NOT LIKE '%btrim%' OR check_def NOT LIKE '%200%' OR check_def NOT LIKE '%2%') THEN
      RAISE EXCEPTION 'Unexpected title CHECK definition: %', check_def;
    ELSIF required_check='document_type' AND (check_def NOT LIKE '%petition%' OR check_def NOT LIKE '%other%') THEN
      RAISE EXCEPTION 'Unexpected document_type CHECK definition: %', check_def;
    ELSIF required_check='description' AND check_def NOT LIKE '%3000%' THEN
      RAISE EXCEPTION 'Unexpected description CHECK definition: %', check_def;
    ELSIF required_check='size_bytes' AND (check_def NOT LIKE '%26214400%' OR check_def NOT LIKE '%0%') THEN
      RAISE EXCEPTION 'Unexpected size_bytes CHECK definition: %', check_def;
    ELSIF required_check='reference_number' AND check_def NOT LIKE '%120%' THEN
      RAISE EXCEPTION 'Unexpected reference_number CHECK definition: %', check_def;
    ELSIF required_check='confidentiality' AND (check_def NOT LIKE '%normal%' OR check_def NOT LIKE '%restricted%') THEN
      RAISE EXCEPTION 'Unexpected confidentiality CHECK definition: %', check_def;
    ELSIF required_check='storage_status' AND check_def NOT LIKE '%metadata_only%' THEN
      RAISE EXCEPTION 'Unexpected storage_status CHECK definition: %', check_def;
    ELSIF required_check='idempotency_pair' AND (check_def NOT LIKE '%idempotency_key%' OR check_def NOT LIKE '%request_fingerprint%') THEN
      RAISE EXCEPTION 'Unexpected idempotency-pair CHECK definition: %', check_def;
    END IF;
  END LOOP;

  -- Check each operational index's real key order, validity, uniqueness and partial predicate.
  SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
               JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
               WHERE k.ord <= i.indnkeyatts ORDER BY k.ord),
         pg_get_expr(i.indpred,i.indrelid), pg_get_indexdef(i.indexrelid)
    INTO index_keys,index_predicate,index_definition
  FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
  WHERE i.indrelid='public.case_documents'::regclass AND ix.relname='case_documents_idempotency_unique_idx'
    AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
    AND i.indpred IS NOT NULL AND i.indexprs IS NULL AND i.indnkeyatts=3;
  IF index_keys IS DISTINCT FROM ARRAY['office_id','created_by','idempotency_key']::text[]
     OR index_predicate NOT LIKE '%idempotency_key IS NOT NULL%' THEN
    RAISE EXCEPTION 'Invalid idempotency index definition: %, predicate=%', index_definition,index_predicate;
  END IF;

  FOR fk IN
    SELECT ix.relname,
           ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ord)
                 JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                 WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
           pg_get_expr(i.indpred,i.indrelid) AS predicate,
           i.indisvalid, i.indisready, i.indislive, i.indisunique
    FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    WHERE i.indrelid='public.case_documents'::regclass
      AND ix.relname IN ('case_documents_office_case_created_idx','case_documents_office_created_idx')
  LOOP
    IF NOT fk.indisvalid OR NOT fk.indisready OR NOT fk.indislive OR fk.indisunique
       OR fk.predicate NOT LIKE '%deleted_at IS NULL%' THEN
      RAISE EXCEPTION 'Invalid active-document index %: keys %, predicate %', fk.relname,fk.keys,fk.predicate;
    END IF;
    IF fk.relname='case_documents_office_case_created_idx'
       AND fk.keys IS DISTINCT FROM ARRAY['office_id','case_id','created_at']::text[] THEN
      RAISE EXCEPTION 'Unexpected office/case index key order: %', fk.keys;
    ELSIF fk.relname='case_documents_office_created_idx'
       AND fk.keys IS DISTINCT FROM ARRAY['office_id','created_at']::text[] THEN
      RAISE EXCEPTION 'Unexpected office index key order: %', fk.keys;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
      WHERE i.indrelid='public.case_documents'::regclass
        AND ix.relname IN ('case_documents_office_case_created_idx','case_documents_office_created_idx')
        AND i.indisvalid AND i.indisready AND i.indislive) <> 2 THEN
    RAISE EXCEPTION 'Expected both valid active-document indexes';
  END IF;
END
$document_catalog$;

DO $probe$
DECLARE expr text; ok boolean;
BEGIN
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO expr FROM pg_constraint c
  WHERE c.conrelid='public.case_documents'::regclass AND c.contype='c'
    AND pg_get_constraintdef(c.oid,true) LIKE '%storage_status%';
  EXECUTE 'SELECT (' || regexp_replace(expr, '\mstorage_status\M', quote_literal('metadata_only'), 'g') || ')' INTO ok;
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'metadata_only rejected by CHECK'; END IF;
  EXECUTE 'SELECT (' || regexp_replace(expr, '\mstorage_status\M', quote_literal('stored'), 'g') || ')' INTO ok;
  IF ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'stored unexpectedly accepted'; END IF;
  EXECUTE 'SELECT (' || regexp_replace(expr, '\mstorage_status\M', quote_literal('pending_storage'), 'g') || ')' INTO ok;
  IF ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'pending_storage unexpectedly accepted'; END IF;
  EXECUTE 'SELECT (' || regexp_replace(expr, '\mstorage_status\M', quote_literal('quarantined'), 'g') || ')' INTO ok;
  IF ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'quarantined unexpectedly accepted'; END IF;
END
$probe$;


DO $rate_limit_catalog$
DECLARE cols text[]; pk_columns text[]; digest_check boolean; expiry_index boolean;
BEGIN
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO cols
  FROM pg_attribute a
  WHERE a.attrelid='public.rate_limit_counters'::regclass
    AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM ARRAY[
    'bucket_name','key_digest','window_start','request_count','expires_at'
  ]::text[] THEN
    RAISE EXCEPTION 'Unexpected rate_limit_counters columns: %', cols;
  END IF;
  SELECT array_agg(a.attname::text ORDER BY k.ordinality) INTO pk_columns
  FROM pg_constraint c
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
  WHERE c.conrelid='public.rate_limit_counters'::regclass AND c.contype='p';
  IF pk_columns IS DISTINCT FROM ARRAY['bucket_name','key_digest','window_start']::text[] THEN
    RAISE EXCEPTION 'Unexpected rate_limit_counters primary key: %', pk_columns;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.rate_limit_counters'::regclass AND contype='c'
      AND pg_get_constraintdef(oid,true) LIKE '%octet_length(key_digest)%'
  ) INTO digest_check;
  IF NOT digest_check THEN RAISE EXCEPTION 'Missing 32-byte digest check'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
    WHERE i.indrelid='public.rate_limit_counters'::regclass
      AND ix.relname='rate_limit_counters_expires_at_idx'
      AND i.indisvalid AND i.indisready AND i.indisunique=false
      AND pg_get_indexdef(i.indexrelid) ILIKE '%(expires_at)%'
  ) INTO expiry_index;
  IF NOT expiry_index THEN RAISE EXCEPTION 'Missing valid expiry cleanup index'; END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class rel
    CROSS JOIN LATERAL aclexplode(coalesce(rel.relacl, acldefault('r', rel.relowner))) acl
    WHERE rel.oid='public.rate_limit_counters'::regclass
      AND acl.grantee=0
  ) THEN
    RAISE EXCEPTION 'PUBLIC must not receive any counter table privilege';
  END IF;
  -- This is a global IP-derived counter table, not tenant-owned business data.
  -- RLS is intentionally not enabled: access must be controlled by explicit
  -- table grants to the verified backend role, not a misleading tenant policy.
  IF (SELECT relrowsecurity FROM pg_class WHERE oid='public.rate_limit_counters'::regclass) THEN
    RAISE EXCEPTION 'Unexpected RLS policy mode for global rate-limit counters';
  END IF;
END
$rate_limit_catalog$;

DO $mutation_idempotency_catalog$
DECLARE cols text[];
BEGIN
  SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO cols
  FROM pg_attribute a
  WHERE a.attrelid='public.case_document_mutation_idempotency'::regclass
    AND a.attnum>0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM ARRAY[
    'office_id','user_id','idempotency_key','operation','entity_id',
    'request_fingerprint','response_status','created_at','purged_at'
  ]::text[] THEN
    RAISE EXCEPTION 'Unexpected mutation idempotency column inventory: %', cols;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.case_document_mutation_idempotency'::regclass
      AND conname='case_document_mutation_idempotency_pkey' AND contype='p'
  ) THEN RAISE EXCEPTION 'Mutation idempotency primary key missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.case_document_mutation_idempotency'::regclass
      AND contype='f' AND convalidated
  ) THEN RAISE EXCEPTION 'Mutation idempotency office/user FK missing'; END IF;
END
$mutation_idempotency_catalog$;
