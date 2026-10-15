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

CREATE FUNCTION public.prevent_case_document_idempotency_reopen()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.office_id IS DISTINCT FROM OLD.office_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'idempotency operation identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.response_status IS NOT NULL AND NEW.response_status IS DISTINCT FROM OLD.response_status THEN
    RAISE EXCEPTION 'completed idempotency response status is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
    RAISE EXCEPTION 'idempotency tombstones are irreversible'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.response_status IS NULL AND NEW.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'incomplete idempotency reservations cannot be tombstoned'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER case_document_mutation_idempotency_identity_immutable
BEFORE UPDATE ON public.case_document_mutation_idempotency
FOR EACH ROW EXECUTE FUNCTION public.prevent_case_document_idempotency_reopen();


COMMIT;
