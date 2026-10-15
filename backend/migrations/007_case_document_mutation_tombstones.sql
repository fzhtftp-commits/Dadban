BEGIN;

-- Retention never deletes operation identity. Mark the response as purged while
-- retaining the minimal key/fingerprint tombstone to prevent a key reopening.
ALTER TABLE public.case_document_mutation_idempotency
  ADD COLUMN purged_at timestamptz;

ALTER TABLE public.case_document_mutation_idempotency
  ADD CONSTRAINT case_document_mutation_idempotency_purged_completed_check
  CHECK (purged_at IS NULL OR response_status IS NOT NULL);

CREATE INDEX case_document_mutation_idempotency_purged_at_idx
  ON public.case_document_mutation_idempotency (purged_at)
  WHERE purged_at IS NOT NULL;

COMMENT ON COLUMN public.case_document_mutation_idempotency.purged_at IS
  'Response replay is disabled after retention; key identity remains as a durable tombstone. Never DELETE this row.';

CREATE FUNCTION public.prevent_case_document_idempotency_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'case document idempotency records are durable tombstones; mark purged_at instead of deleting'
    USING ERRCODE = 'restrict_violation';
END
$function$;

CREATE TRIGGER case_document_mutation_idempotency_no_delete
BEFORE DELETE ON public.case_document_mutation_idempotency
FOR EACH ROW EXECUTE FUNCTION public.prevent_case_document_idempotency_delete();

COMMIT;
