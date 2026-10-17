BEGIN;

-- The generic API idempotency table must retain a completed operation's identity
-- even when its response body is purged. Runtime callers can only complete a
-- pending reservation; they cannot edit the tombstone marker or delete rows.
CREATE FUNCTION public.guard_api_mutation_idempotency_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'API idempotency records are durable tombstones; DELETE is forbidden'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.office_id IS DISTINCT FROM OLD.office_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'API idempotency operation identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.response_status IS NULL THEN
    IF OLD.completed_at IS NOT NULL OR OLD.response_body_purged OR OLD.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'incomplete API idempotency reservation has invalid prior state'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.response_body_purged OR NEW.purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'incomplete API idempotency reservation cannot be purged'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.response_status IS DISTINCT FROM OLD.response_status
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'completed API idempotency result identity is immutable'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.response_body_purged THEN
      IF NOT NEW.response_body_purged
         OR NEW.purged_at IS DISTINCT FROM OLD.purged_at
         OR NEW.response_body IS NOT NULL THEN
        RAISE EXCEPTION 'API idempotency tombstones are irreversible'
          USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF NEW.response_body_purged THEN
      IF NEW.response_body IS NOT NULL OR NEW.purged_at IS NULL THEN
        RAISE EXCEPTION 'purging must remove the response body and record purged_at'
          USING ERRCODE = 'restrict_violation';
      END IF;
    ELSIF NEW.response_body IS DISTINCT FROM OLD.response_body
       OR NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
      RAISE EXCEPTION 'completed API idempotency response can only transition to a tombstone'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.guard_api_mutation_idempotency_identity() FROM PUBLIC;

CREATE TRIGGER api_mutation_idempotency_no_delete
BEFORE DELETE ON public.api_mutation_idempotency
FOR EACH ROW EXECUTE FUNCTION public.guard_api_mutation_idempotency_identity();

CREATE TRIGGER api_mutation_idempotency_identity_immutable
BEFORE UPDATE ON public.api_mutation_idempotency
FOR EACH ROW EXECUTE FUNCTION public.guard_api_mutation_idempotency_identity();

COMMENT ON FUNCTION public.guard_api_mutation_idempotency_identity() IS
  'Prevents deletion, identity changes, completed-result rewriting, and reopening a purged API idempotency tombstone.';

COMMIT;
