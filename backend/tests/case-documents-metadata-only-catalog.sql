\set ON_ERROR_STOP on
-- Run only after the migration in disposable PostgreSQL.
DO $catalog$
DECLARE cols text[];
BEGIN
 SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO cols
 FROM pg_attribute a WHERE a.attrelid='public.case_documents'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF cols IS DISTINCT FROM ARRAY['id','office_id','case_id','title','document_type','description','original_filename','mime_type','size_bytes','document_date','reference_number','confidentiality','idempotency_key','request_fingerprint','storage_status','created_by','updated_by','created_at','updated_at','deleted_at']::text[] THEN
   RAISE EXCEPTION 'column catalog mismatch: %', cols;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.case_documents'::regclass AND attname='storage_key' AND NOT attisdropped) THEN
   RAISE EXCEPTION 'forbidden storage_key column exists';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.case_documents'::regclass AND conname='case_documents_storage_status_check' AND contype='c' AND convalidated AND pg_get_constraintdef(oid,true) LIKE '%metadata_only%') THEN
   RAISE EXCEPTION 'metadata-only storage CHECK is missing or invalid';
 END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.case_documents'::regclass AND contype='f') <> 4 THEN
   RAISE EXCEPTION 'expected four foreign keys: office plus three office-scoped references';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.case_documents'::regclass AND tgname='case_documents_set_updated_at' AND NOT tgisinternal) THEN
   RAISE EXCEPTION 'updated_at trigger missing';
 END IF;
END
$catalog$;
