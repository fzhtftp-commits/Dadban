-- Dadban case-document metadata only. No file/object storage is supported.
-- Strict preflight validates referenced composite unique indexes from PostgreSQL catalog.
-- Existing case_documents objects are never silently accepted or upgraded.
BEGIN;
DO $preflight$
DECLARE tbl record; ok boolean;
BEGIN
  IF to_regclass('case_documents') IS NOT NULL THEN
    RAISE EXCEPTION 'case_documents already exists; audit its full catalog definition before migration';
  END IF;
  -- Accept any valid catalog-verified unique index on exactly (id, office_id);
  -- do not assume that an object name proves its definition.
  FOR tbl IN SELECT * FROM (VALUES ('public.users'::regclass), ('public.cases'::regclass)) AS t(table_oid)
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indrelid=tbl.table_oid
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
        AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=2
        AND ARRAY(
          SELECT a.attname::text
          FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
          WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
        ) = ARRAY['id','office_id']::text[]
    ) INTO ok;
    IF ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Required valid unique index on % (id, office_id) is missing or incompatible', tbl.table_oid::regclass;
    END IF;
  END LOOP;
END
$preflight$;
CREATE TABLE case_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id) ON DELETE RESTRICT,
  case_id uuid NOT NULL,
  title varchar(200) NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 200),
  document_type varchar(32) NOT NULL DEFAULT 'other'
    CHECK (document_type IN ('petition','pleading','contract','evidence','court_order','correspondence','identity','receipt','other')),
  description varchar(3000) CHECK (description IS NULL OR length(description) <= 3000),
  original_filename varchar(255),
  mime_type varchar(127),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 0 AND 26214400),
  document_date date,
  reference_number varchar(120) CHECK (reference_number IS NULL OR length(reference_number) <= 120),
  confidentiality varchar(16) NOT NULL DEFAULT 'confidential'
    CHECK (confidentiality IN ('normal','confidential','restricted')),
  idempotency_key varchar(128),
  request_fingerprint char(64),
  storage_status varchar(24) NOT NULL DEFAULT 'metadata_only'
    CHECK (storage_status = 'metadata_only'),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT case_documents_case_same_office_fk
    FOREIGN KEY (case_id, office_id) REFERENCES cases(id, office_id) ON DELETE RESTRICT,
  CONSTRAINT case_documents_created_by_same_office_fk
    FOREIGN KEY (created_by, office_id) REFERENCES users(id, office_id) ON DELETE RESTRICT,
  CONSTRAINT case_documents_updated_by_same_office_fk
    FOREIGN KEY (updated_by, office_id) REFERENCES users(id, office_id) ON DELETE RESTRICT,
  CONSTRAINT case_documents_idempotency_pair
    CHECK ((idempotency_key IS NULL AND request_fingerprint IS NULL) OR
           (idempotency_key IS NOT NULL AND request_fingerprint IS NOT NULL))
);
CREATE UNIQUE INDEX case_documents_idempotency_unique_idx
  ON case_documents (office_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
create index case_documents_office_case_created_idx on case_documents (office_id, case_id, created_at desc) where deleted_at is null;
create index case_documents_office_created_idx on case_documents (office_id, created_at desc) where deleted_at is null;
CREATE TRIGGER case_documents_set_updated_at
  BEFORE UPDATE ON case_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMIT;
