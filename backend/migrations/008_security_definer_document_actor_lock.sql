BEGIN;

-- A dedicated non-login, non-superuser owner holds only the privileges required
-- for SELECT ... FOR UPDATE on the session/user rows. The API runtime never gets
-- UPDATE(full_name); the helper is not executable by PUBLIC.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_actor_lock_owner') THEN
    CREATE ROLE dadban_actor_lock_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$role$;
ALTER ROLE dadban_actor_lock_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

DO $preflight$
DECLARE owner_state record;
BEGIN
  SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit
    INTO owner_state FROM pg_roles WHERE rolname='dadban_actor_lock_owner';
  IF owner_state.rolsuper OR owner_state.rolcanlogin OR owner_state.rolcreatedb
     OR owner_state.rolcreaterole OR owner_state.rolinherit THEN
    RAISE EXCEPTION 'dadban_actor_lock_owner must be NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
  END IF;
  -- A membership either way could let another login SET ROLE to this owner or
  -- let this owner assume broader privileges; the dedicated owner must be isolated.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles owner_role ON owner_role.oid = m.roleid OR owner_role.oid = m.member
    WHERE owner_role.rolname = 'dadban_actor_lock_owner'
  ) THEN
    RAISE EXCEPTION 'dadban_actor_lock_owner must not participate in role memberships';
  END IF;
END
$preflight$;

GRANT USAGE ON SCHEMA public TO dadban_actor_lock_owner;
GRANT SELECT ON public.auth_sessions, public.users, public.clients, public.cases TO dadban_actor_lock_owner;
-- PostgreSQL requires UPDATE privilege on each FOR UPDATE target. Keep these
-- narrow column grants on the non-login function owner, never on the API runtime.
GRANT UPDATE (revoked_at) ON public.auth_sessions TO dadban_actor_lock_owner;
GRANT UPDATE (full_name) ON public.users TO dadban_actor_lock_owner;
GRANT UPDATE (deleted_at) ON public.clients, public.cases TO dadban_actor_lock_owner;

CREATE FUNCTION public.lock_live_document_actor(p_session uuid, p_user uuid, p_office uuid)
RETURNS TABLE(valid boolean, actor_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE locked_role text; is_live boolean; locked_session uuid;
BEGIN
  -- Establish a deterministic lock order for every caller: session first, user second.
  -- A joined FOR UPDATE OF s,u leaves lock acquisition dependent on the chosen join plan;
  -- separate statements prevent callers from taking these two rows in opposite orders.
  SELECT s.id INTO locked_session
  FROM public.auth_sessions AS s
  WHERE s.id=p_session AND s.user_id=p_user AND s.office_id=p_office
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  SELECT u.role INTO locked_role
  FROM public.users AS u
  WHERE u.id=p_user AND u.office_id=p_office
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text;
    RETURN;
  END IF;

  -- Re-read after both locks are held so expiry/revocation/disable changes committed
  -- while waiting are reflected in the authorization decision.
  SELECT (s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
          AND u.is_active AND u.deleted_at IS NULL), u.role
    INTO is_live, locked_role
  FROM public.auth_sessions AS s
  JOIN public.users AS u ON u.id=s.user_id AND u.office_id=s.office_id
  WHERE s.id=p_session AND s.user_id=p_user AND s.office_id=p_office;

  RETURN QUERY SELECT coalesce(is_live,false), locked_role;
END
$function$;

ALTER FUNCTION public.lock_live_document_actor(uuid,uuid,uuid) OWNER TO dadban_actor_lock_owner;
REVOKE ALL ON FUNCTION public.lock_live_document_actor(uuid,uuid,uuid) FROM PUBLIC;

-- Parent-row locks serialize child writes against a concurrent soft-delete without
-- granting the application UPDATE privileges on clients/cases. The NOLOGIN owner
-- holds only UPDATE(deleted_at), required by PostgreSQL for SELECT ... FOR UPDATE.
CREATE FUNCTION public.lock_live_client_parent(p_client uuid, p_office uuid)
RETURNS TABLE(id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN QUERY
    SELECT cl.id
    FROM public.clients AS cl
    WHERE cl.id=p_client AND cl.office_id=p_office AND cl.deleted_at IS NULL
    FOR UPDATE;
END
$function$;
ALTER FUNCTION public.lock_live_client_parent(uuid,uuid) OWNER TO dadban_actor_lock_owner;
REVOKE ALL ON FUNCTION public.lock_live_client_parent(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.lock_live_case_client(p_case uuid, p_office uuid)
RETURNS TABLE(id uuid, client_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN QUERY
    SELECT c.id, c.client_id
    FROM public.cases AS c
    WHERE c.id=p_case AND c.office_id=p_office AND c.deleted_at IS NULL
    FOR UPDATE;
END
$function$;
ALTER FUNCTION public.lock_live_case_client(uuid,uuid) OWNER TO dadban_actor_lock_owner;
REVOKE ALL ON FUNCTION public.lock_live_case_client(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.lock_live_case_parents(p_office uuid, p_case_ids uuid[])
RETURNS TABLE(id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- Stable UUID order avoids A→B/B→A lock cycles. READ COMMITTED rechecks the
  -- deleted_at predicate after waiting for a concurrent soft-delete.
  RETURN QUERY
    SELECT c.id
    FROM public.cases AS c
    WHERE c.office_id=p_office AND c.id=ANY(p_case_ids) AND c.deleted_at IS NULL
    ORDER BY c.id
    FOR UPDATE;
END
$function$;
ALTER FUNCTION public.lock_live_case_parents(uuid,uuid[]) OWNER TO dadban_actor_lock_owner;
REVOKE ALL ON FUNCTION public.lock_live_case_parents(uuid,uuid[]) FROM PUBLIC;

-- Grant to known application-role names only when present. Deployments using a
-- different DB login must explicitly GRANT EXECUTE to that runtime role.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.lock_live_document_actor(uuid,uuid,uuid) TO dadban_document_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime_ci') THEN
    GRANT EXECUTE ON FUNCTION public.lock_live_document_actor(uuid,uuid,uuid) TO dadban_document_runtime_ci;
    GRANT EXECUTE ON FUNCTION public.lock_live_client_parent(uuid,uuid) TO dadban_document_runtime_ci;
    GRANT EXECUTE ON FUNCTION public.lock_live_case_client(uuid,uuid) TO dadban_document_runtime_ci;
    GRANT EXECUTE ON FUNCTION public.lock_live_case_parents(uuid,uuid[]) TO dadban_document_runtime_ci;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_document_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.lock_live_client_parent(uuid,uuid) TO dadban_document_runtime;
    GRANT EXECUTE ON FUNCTION public.lock_live_case_client(uuid,uuid) TO dadban_document_runtime;
    GRANT EXECUTE ON FUNCTION public.lock_live_case_parents(uuid,uuid[]) TO dadban_document_runtime;
  END IF;
END
$grants$;

COMMIT;
