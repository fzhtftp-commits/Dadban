BEGIN;

-- Migration 009 can be rerun independently after role drift. Revalidate the
-- SECURITY DEFINER owner immediately before transferring another function to it.
DO $owner_preflight$
DECLARE owner_state record;
BEGIN
  SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit
    INTO owner_state
  FROM pg_roles
  WHERE rolname='dadban_actor_lock_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dadban_actor_lock_owner must be provisioned by migration 008 first';
  END IF;
  IF owner_state.rolsuper OR owner_state.rolcanlogin OR owner_state.rolcreatedb
     OR owner_state.rolcreaterole OR owner_state.rolinherit THEN
    RAISE EXCEPTION 'dadban_actor_lock_owner must remain NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members m
    JOIN pg_roles owner_role ON owner_role.oid=m.roleid OR owner_role.oid=m.member
    WHERE owner_role.rolname='dadban_actor_lock_owner'
  ) THEN
    RAISE EXCEPTION 'dadban_actor_lock_owner must not participate in role memberships';
  END IF;
END
$owner_preflight$;

-- Case reassignment must lock the live case first, then both its current and
-- requested client rows in a single stable UUID order. This prevents a case
-- from being moved away after its old client was soft-deleted and prevents
-- opposing A->B / B->A transfers from acquiring client locks in reverse order.
CREATE FUNCTION public.lock_live_case_reassignment(
  p_case uuid,
  p_office uuid,
  p_target_client uuid
)
RETURNS TABLE(id uuid, old_client_id uuid, target_client_id uuid, parents_live boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  locked_case record;
  locked_client record;
  locked_client_ids uuid[] := ARRAY[]::uuid[];
  expected_client_count integer;
BEGIN
  SELECT c.id, c.client_id
    INTO locked_case
  FROM public.cases AS c
  WHERE c.id = p_case
    AND c.office_id = p_office
    AND c.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_target_client IS NULL THEN
    p_target_client := locked_case.client_id;
  END IF;

  SELECT count(DISTINCT client_id)::integer
    INTO expected_client_count
  FROM unnest(ARRAY[locked_case.client_id, p_target_client]) AS requested(client_id);

  FOR locked_client IN
    SELECT cl.id
    FROM public.clients AS cl
    WHERE cl.office_id = p_office
      AND cl.id = ANY(ARRAY[locked_case.client_id, p_target_client])
      AND cl.deleted_at IS NULL
    ORDER BY cl.id
    FOR UPDATE
  LOOP
    locked_client_ids := array_append(locked_client_ids, locked_client.id);
  END LOOP;

  -- Under READ COMMITTED, a row whose soft-delete won while this statement
  -- waited is rechecked against deleted_at and is not counted as live.
  RETURN QUERY
    SELECT locked_case.id,
           locked_case.client_id,
           p_target_client,
           cardinality(locked_client_ids) = expected_client_count;
END
$function$;

ALTER FUNCTION public.lock_live_case_reassignment(uuid,uuid,uuid) OWNER TO dadban_actor_lock_owner;
REVOKE ALL ON FUNCTION public.lock_live_case_reassignment(uuid,uuid,uuid) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.lock_live_case_reassignment(uuid,uuid,uuid) TO dadban_document_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_ci') THEN
    GRANT EXECUTE ON FUNCTION public.lock_live_case_reassignment(uuid,uuid,uuid) TO dadban_document_runtime_ci;
  END IF;
END
$grants$;

COMMIT;
