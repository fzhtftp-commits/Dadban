-- Dadban authentication bootstrap hardening (staged; do not apply to production yet)
-- Prerequisite: review the role ownership model and create/grant dadban_runtime
-- separately. This migration intentionally does not change DATABASE_URL or Render.
--
-- A non-login, non-bypass function owner is used so SECURITY DEFINER functions
-- do not execute as the table-owning postgres role. All function table references
-- are schema-qualified and the search_path is fixed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dadban_auth_owner') THEN
    CREATE ROLE dadban_auth_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE dadban_auth_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE, CREATE ON SCHEMA public TO dadban_auth_owner;
GRANT SELECT, INSERT, UPDATE ON public.offices TO dadban_auth_owner;
GRANT SELECT, INSERT, UPDATE ON public.users TO dadban_auth_owner;
GRANT SELECT, INSERT, UPDATE ON public.auth_credentials TO dadban_auth_owner;
GRANT SELECT, INSERT, UPDATE ON public.auth_sessions TO dadban_auth_owner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dadban_auth_owner;

-- Policies are role-scoped to the NOLOGIN function owner. Application sessions
-- do not receive these policies and cannot use the role directly.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_auth_owner_access ON public.users;
CREATE POLICY users_auth_owner_access ON public.users
  FOR ALL TO dadban_auth_owner USING (true) WITH CHECK (true);

ALTER TABLE public.auth_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_credentials_owner_access ON public.auth_credentials;
CREATE POLICY auth_credentials_owner_access ON public.auth_credentials
  FOR ALL TO dadban_auth_owner USING (true) WITH CHECK (true);

ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_sessions_owner_access ON public.auth_sessions;
CREATE POLICY auth_sessions_owner_access ON public.auth_sessions
  FOR ALL TO dadban_auth_owner USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.dadban_auth_login_lookup(p_email text)
RETURNS TABLE (
  id uuid, office_id uuid, full_name varchar, email varchar, role varchar, password_hash text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.office_id, u.full_name, u.email, u.role, c.password_hash
  FROM public.users AS u
  JOIN public.auth_credentials AS c ON c.user_id = u.id
  WHERE lower(u.email) = lower(p_email)
    AND u.is_active = true
    AND u.deleted_at IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.dadban_auth_session_lookup(p_token_hash text)
RETURNS TABLE (
  session_id uuid, user_id uuid, office_id uuid, csrf_hash char,
  full_name varchar, email varchar, role varchar
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.user_id, s.office_id, s.csrf_hash, u.full_name, u.email, u.role
  FROM public.auth_sessions AS s
  JOIN public.users AS u ON u.id = s.user_id AND u.office_id = s.office_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND u.is_active = true
    AND u.deleted_at IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.dadban_auth_create_session(
  p_user_id uuid, p_office_id uuid, p_token_hash text, p_csrf_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_user_id AND u.office_id = p_office_id
      AND u.is_active = true AND u.deleted_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO public.auth_sessions
    (user_id, office_id, token_hash, csrf_hash, expires_at)
  VALUES (p_user_id, p_office_id, p_token_hash, p_csrf_hash, now() + interval '8 hours');
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION public.dadban_auth_register(
  p_full_name text, p_email text, p_office_name text, p_password_hash text,
  p_token_hash text, p_csrf_hash text
)
RETURNS TABLE (id uuid, office_id uuid, full_name varchar, email varchar, role varchar)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_office_id uuid;
  v_user_id uuid;
BEGIN
  INSERT INTO public.offices (name) VALUES (p_office_name) RETURNING offices.id INTO v_office_id;
  INSERT INTO public.users (office_id, full_name, email, role)
    VALUES (v_office_id, p_full_name, lower(p_email), 'owner')
    RETURNING users.id INTO v_user_id;
  INSERT INTO public.auth_credentials (user_id, password_hash)
    VALUES (v_user_id, p_password_hash);
  INSERT INTO public.auth_sessions (user_id, office_id, token_hash, csrf_hash, expires_at)
    VALUES (v_user_id, v_office_id, p_token_hash, p_csrf_hash, now() + interval '8 hours');
  RETURN QUERY
    SELECT u.id, u.office_id, u.full_name, u.email, u.role
    FROM public.users u WHERE u.id = v_user_id;
END
$$;

CREATE OR REPLACE FUNCTION public.dadban_auth_update_session(
  p_session_id uuid, p_office_id uuid, p_action text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_context text;
  v_count integer;
BEGIN
  v_context := current_setting('app.current_office_id', true);
  IF v_context IS NULL OR v_context = '' OR v_context <> p_office_id::text THEN
    RETURN false;
  END IF;
  IF p_action = 'touch' THEN
    UPDATE public.auth_sessions
      SET last_seen_at = now()
      WHERE id = p_session_id AND office_id = p_office_id
        AND revoked_at IS NULL AND expires_at > now();
  ELSIF p_action = 'revoke' THEN
    UPDATE public.auth_sessions
      SET revoked_at = now()
      WHERE id = p_session_id AND office_id = p_office_id
        AND revoked_at IS NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported session action';
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END
$$;

-- SECURITY DEFINER functions must not remain owned by the migration/admin role.
ALTER FUNCTION public.dadban_auth_login_lookup(text) OWNER TO dadban_auth_owner;
ALTER FUNCTION public.dadban_auth_session_lookup(text) OWNER TO dadban_auth_owner;
ALTER FUNCTION public.dadban_auth_create_session(uuid, uuid, text, text) OWNER TO dadban_auth_owner;
ALTER FUNCTION public.dadban_auth_register(text, text, text, text, text, text) OWNER TO dadban_auth_owner;
ALTER FUNCTION public.dadban_auth_update_session(uuid, uuid, text) OWNER TO dadban_auth_owner;

-- CREATE was needed only for ownership transfer; remove it from the definer role.
REVOKE CREATE ON SCHEMA public FROM dadban_auth_owner;

REVOKE ALL ON FUNCTION public.dadban_auth_login_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dadban_auth_session_lookup(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dadban_auth_create_session(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dadban_auth_register(text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dadban_auth_update_session(uuid, uuid, text) FROM PUBLIC;

-- The application role must not read credential hashes or session rows directly.
-- Its authentication access is limited to the reviewed function entry points.
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dadban_runtime') THEN
    REVOKE ALL ON public.auth_credentials FROM dadban_runtime;
    REVOKE ALL ON public.auth_sessions FROM dadban_runtime;
  END IF;
END
$;

-- Explicitly grant function entry points only to the intended app role if it exists.
-- If absent, deployment must provision dadban_runtime and re-run this grant block.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dadban_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.dadban_auth_login_lookup(text) TO dadban_runtime;
    GRANT EXECUTE ON FUNCTION public.dadban_auth_session_lookup(text) TO dadban_runtime;
    GRANT EXECUTE ON FUNCTION public.dadban_auth_create_session(uuid, uuid, text, text) TO dadban_runtime;
    GRANT EXECUTE ON FUNCTION public.dadban_auth_register(text, text, text, text, text, text) TO dadban_runtime;
    GRANT EXECUTE ON FUNCTION public.dadban_auth_update_session(uuid, uuid, text) TO dadban_runtime;
  END IF;
END
$$;

-- Keep auth data unavailable to the function owner through direct client sessions:
-- dadban_auth_owner is NOLOGIN; only SECURITY DEFINER entry points are exposed.
