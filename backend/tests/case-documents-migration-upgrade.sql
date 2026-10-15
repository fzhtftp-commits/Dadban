\set ON_ERROR_STOP on
-- Fresh upgrade rehearsal. This file is run only against workflow disposable PostgreSQL.
\ir ../../database/schema.sql
\ir ../../database/migrations/20261010_office_isolation_constraints.sql
\ir ../../database/migrations/20261014_case_actions.sql
\ir ../migrations/004_case_documents_metadata.sql

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

DO $probe$
DECLARE expr text; ok boolean;
BEGIN
  SELECT pg_get_constraintdef(c.oid,true) INTO expr FROM pg_constraint c
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
