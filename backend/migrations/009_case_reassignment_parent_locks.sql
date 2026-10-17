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

-- Migration 009 independently verifies the runtime boundary before granting
-- another SECURITY DEFINER capability, even if memberships drift after 008.
DO $runtime_preflight$
DECLARE runtime_role record;
BEGIN
  FOR runtime_role IN
    SELECT oid, rolname FROM pg_roles
    WHERE rolname IN ('dadban_document_runtime','dadban_document_runtime_ci')
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.member=runtime_role.oid OR m.roleid=runtime_role.oid
    ) THEN
      RAISE EXCEPTION 'runtime role % must not participate in role memberships', runtime_role.rolname;
    END IF;
  END LOOP;
END
$runtime_preflight$;

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

-- CREATE OR REPLACE preserves prior ACLs. Reset the reassignment helper so no
-- stale direct grant or runtime GRANT OPTION survives a migration replay.
DO $function_acl_hardening$
DECLARE
  fn record;
  grantee record;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proowner
    FROM pg_proc p
    WHERE p.oid='public.lock_live_case_reassignment(uuid,uuid,uuid)'::regprocedure
  LOOP
    FOR grantee IN
      SELECT DISTINCT r.rolname
      FROM aclexplode(coalesce(
        (SELECT p.proacl FROM pg_proc p WHERE p.oid=fn.oid),
        acldefault('f', fn.proowner)
      )) acl
      JOIN pg_roles r ON r.oid=acl.grantee
      WHERE acl.privilege_type='EXECUTE'
        AND r.oid <> fn.proowner
        AND r.rolname NOT IN ('dadban_document_runtime','dadban_document_runtime_ci')
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',
        fn.oid::regprocedure, grantee.rolname);
    END LOOP;
  END LOOP;
END
$function_acl_hardening$;

DO $runtime_acl_reset$
DECLARE
  runtime_name text;
BEGIN
  FOREACH runtime_name IN ARRAY ARRAY['dadban_document_runtime','dadban_document_runtime_ci'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_name) THEN
      REVOKE ALL ON FUNCTION public.lock_live_case_reassignment(uuid,uuid,uuid) FROM PUBLIC;
      EXECUTE format('REVOKE ALL ON FUNCTION public.lock_live_case_reassignment(uuid,uuid,uuid) FROM %I', runtime_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.lock_live_case_reassignment(uuid,uuid,uuid) TO %I', runtime_name);
    END IF;
  END LOOP;
END
$runtime_acl_reset$;

-- This NOLOGIN definer role needs no schema object-creation capability after
-- ownership transfer. Remove stale/manual grants when migration 009 is replayed.
REVOKE CREATE ON SCHEMA public FROM dadban_actor_lock_owner;

COMMIT;
