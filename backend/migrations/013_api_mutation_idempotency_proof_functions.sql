BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $crypto_preflight$
BEGIN
  IF to_regprocedure('public.hmac(bytea,bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto HMAC function must be installed in trusted schema public';
  END IF;
END
$crypto_preflight$;

CREATE SCHEMA IF NOT EXISTS dadban_private;
REVOKE ALL ON SCHEMA dadban_private FROM PUBLIC;

-- The API and database receive the same random 32-byte key out of band.
-- Runtime logins cannot read or change this singleton.
CREATE TABLE IF NOT EXISTS dadban_private.api_mutation_idempotency_hmac_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  secret bytea,
  CONSTRAINT api_mutation_idempotency_hmac_key_length
    CHECK (secret IS NULL OR octet_length(secret) = 32)
);
INSERT INTO dadban_private.api_mutation_idempotency_hmac_key(singleton, secret)
VALUES (true, NULL)
ON CONFLICT (singleton) DO NOTHING;
REVOKE ALL ON TABLE dadban_private.api_mutation_idempotency_hmac_key FROM PUBLIC;

DO $owner_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='dadban_api_idempotency_owner') THEN
    CREATE ROLE dadban_api_idempotency_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$owner_role$;
ALTER ROLE dadban_api_idempotency_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

DO $owner_preflight$
DECLARE state record;
BEGIN
  SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit
    INTO state FROM pg_roles WHERE rolname='dadban_api_idempotency_owner';
  IF state.rolsuper OR state.rolcanlogin OR state.rolcreatedb OR state.rolcreaterole OR state.rolinherit THEN
    RAISE EXCEPTION 'dadban_api_idempotency_owner must be NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles owner_role ON owner_role.oid=m.roleid OR owner_role.oid=m.member
    WHERE owner_role.rolname='dadban_api_idempotency_owner'
  ) THEN
    RAISE EXCEPTION 'dadban_api_idempotency_owner must not participate in role memberships';
  END IF;
END
$owner_preflight$;

-- PostgreSQL requires UPDATE privilege on a row-lock target. These narrow grants
-- belong to a NOLOGIN function owner, never the API runtime login.
GRANT USAGE, CREATE ON SCHEMA public TO dadban_api_idempotency_owner;
GRANT USAGE ON SCHEMA dadban_private TO dadban_api_idempotency_owner;
GRANT SELECT ON public.auth_sessions, public.users TO dadban_api_idempotency_owner;
GRANT UPDATE (revoked_at) ON public.auth_sessions TO dadban_api_idempotency_owner;
GRANT UPDATE (full_name) ON public.users TO dadban_api_idempotency_owner;
GRANT SELECT ON dadban_private.api_mutation_idempotency_hmac_key TO dadban_api_idempotency_owner;
GRANT SELECT, INSERT, UPDATE ON public.api_mutation_idempotency TO dadban_api_idempotency_owner;

CREATE OR REPLACE FUNCTION public.reserve_api_mutation_idempotency(
  p_session_id uuid,
  p_user_id uuid,
  p_office_id uuid,
  p_idempotency_key text,
  p_resource_type text,
  p_operation text,
  p_request_fingerprint text,
  p_proof text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_secret bytea;
  v_payload text;
  v_expected text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
     OR p_resource_type IS NULL OR p_resource_type NOT IN ('client','case','hearing','case_action')
     OR p_operation IS NULL OR p_operation NOT IN ('POST','PATCH','DELETE')
     OR p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_proof IS NULL OR p_proof !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid API idempotency reservation arguments'
      USING ERRCODE = '22023';
  END IF;

  SELECT secret INTO v_secret
  FROM dadban_private.api_mutation_idempotency_hmac_key
  WHERE singleton = true;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'API idempotency proof key is not provisioned'
      USING ERRCODE = '55000';
  END IF;

  v_payload := concat_ws('|',
    'dadban-idem-v1', 'reserve', p_session_id::text, p_user_id::text,
    p_office_id::text, p_idempotency_key, p_resource_type, p_operation,
    p_request_fingerprint, '', '');
  v_expected := encode(public.hmac(convert_to(v_payload, 'UTF8'), v_secret, 'sha256'), 'hex');
  IF v_expected <> p_proof THEN
    RAISE EXCEPTION 'invalid API idempotency proof' USING ERRCODE = '42501';
  END IF;

  -- Deterministic lock order: session first, user second, then re-check liveness.
  -- Locks remain held until the enclosing business-mutation transaction ends.
  PERFORM 1 FROM public.auth_sessions s
  WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.office_id = p_office_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM public.users u
  WHERE u.id = p_user_id AND u.office_id = p_office_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;
  PERFORM 1
  FROM public.auth_sessions s
  JOIN public.users u ON u.id = s.user_id AND u.office_id = s.office_id
  WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.office_id = p_office_id
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    AND u.is_active = true AND u.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.api_mutation_idempotency(
    office_id, user_id, idempotency_key, resource_type, operation, request_fingerprint
  ) VALUES (
    p_office_id, p_user_id, p_idempotency_key, p_resource_type, p_operation, p_request_fingerprint
  )
  ON CONFLICT (office_id, user_id, idempotency_key) DO NOTHING;

  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION public.read_api_mutation_idempotency(
  p_session_id uuid,
  p_user_id uuid,
  p_office_id uuid,
  p_idempotency_key text,
  p_resource_type text,
  p_operation text,
  p_request_fingerprint text,
  p_proof text
)
RETURNS SETOF public.api_mutation_idempotency
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_secret bytea;
  v_payload text;
  v_expected text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
     OR p_resource_type IS NULL OR p_resource_type NOT IN ('client','case','hearing','case_action')
     OR p_operation IS NULL OR p_operation NOT IN ('POST','PATCH','DELETE')
     OR p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_proof IS NULL OR p_proof !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid API idempotency lookup arguments' USING ERRCODE = '22023';
  END IF;

  SELECT secret INTO v_secret
  FROM dadban_private.api_mutation_idempotency_hmac_key
  WHERE singleton = true;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'API idempotency proof key is not provisioned' USING ERRCODE = '55000';
  END IF;

  v_payload := concat_ws('|',
    'dadban-idem-v1', 'lookup', p_session_id::text, p_user_id::text,
    p_office_id::text, p_idempotency_key, p_resource_type, p_operation,
    p_request_fingerprint, '', '');
  v_expected := encode(public.hmac(convert_to(v_payload, 'UTF8'), v_secret, 'sha256'), 'hex');
  IF v_expected <> p_proof THEN
    RAISE EXCEPTION 'invalid API idempotency proof' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.auth_sessions s
  WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.office_id = p_office_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM public.users u
  WHERE u.id = p_user_id AND u.office_id = p_office_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;
  PERFORM 1
  FROM public.auth_sessions s
  JOIN public.users u ON u.id = s.user_id AND u.office_id = s.office_id
  WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.office_id = p_office_id
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    AND u.is_active = true AND u.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;

  RETURN QUERY
  SELECT r.*
  FROM public.api_mutation_idempotency r
  WHERE r.office_id = p_office_id
    AND r.user_id = p_user_id
    AND r.idempotency_key = p_idempotency_key
  FOR UPDATE;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_api_mutation_idempotency(
  p_session_id uuid,
  p_user_id uuid,
  p_office_id uuid,
  p_idempotency_key text,
  p_resource_type text,
  p_operation text,
  p_request_fingerprint text,
  p_resource_id uuid,
  p_response_status integer,
  p_proof text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_secret bytea;
  v_payload text;
  v_expected text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
     OR p_resource_type IS NULL OR p_resource_type NOT IN ('client','case','hearing','case_action')
     OR p_operation IS NULL OR p_operation NOT IN ('POST','PATCH','DELETE')
     OR p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_proof IS NULL OR p_proof !~ '^[0-9a-f]{64}$'
     OR p_resource_id IS NULL
     OR p_response_status IS NULL OR p_response_status NOT BETWEEN 200 AND 299 THEN
    RAISE EXCEPTION 'invalid API idempotency completion arguments'
      USING ERRCODE = '22023';
  END IF;

  SELECT secret INTO v_secret
  FROM dadban_private.api_mutation_idempotency_hmac_key
  WHERE singleton = true;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'API idempotency proof key is not provisioned'
      USING ERRCODE = '55000';
  END IF;

  v_payload := concat_ws('|',
    'dadban-idem-v1', 'complete', p_session_id::text, p_user_id::text,
    p_office_id::text, p_idempotency_key, p_resource_type, p_operation,
    p_request_fingerprint, p_resource_id::text, p_response_status::text);
  v_expected := encode(public.hmac(convert_to(v_payload, 'UTF8'), v_secret, 'sha256'), 'hex');
  IF v_expected <> p_proof THEN
    RAISE EXCEPTION 'invalid API idempotency proof' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.auth_sessions s
  WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.office_id = p_office_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM public.users u
  WHERE u.id = p_user_id AND u.office_id = p_office_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;
  PERFORM 1
  FROM public.auth_sessions s
  JOIN public.users u ON u.id = s.user_id AND u.office_id = s.office_id
  WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.office_id = p_office_id
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
    AND u.is_active = true AND u.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'live authenticated session required' USING ERRCODE = '28000';
  END IF;

  UPDATE public.api_mutation_idempotency
  SET resource_id = p_resource_id,
      response_status = p_response_status,
      response_body = CASE
        WHEN p_response_status = 204 THEN '{}'::jsonb
        ELSE jsonb_build_object('data', jsonb_build_object('id', p_resource_id))
      END,
      completed_at = clock_timestamp()
  WHERE office_id = p_office_id
    AND user_id = p_user_id
    AND idempotency_key = p_idempotency_key
    AND resource_type = p_resource_type
    AND operation = p_operation
    AND request_fingerprint = p_request_fingerprint
    AND response_status IS NULL;

  RETURN FOUND;
END
$function$;

ALTER FUNCTION public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)
  OWNER TO dadban_api_idempotency_owner;
ALTER FUNCTION public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)
  OWNER TO dadban_api_idempotency_owner;
REVOKE ALL ON FUNCTION public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
ALTER FUNCTION public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)
  OWNER TO dadban_api_idempotency_owner;
REVOKE ALL ON FUNCTION public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text) FROM PUBLIC;

DO $runtime_grants$
DECLARE runtime_name text;
BEGIN
  FOREACH runtime_name IN ARRAY ARRAY['dadban_document_runtime','dadban_document_runtime_ci'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_name) THEN
      IF EXISTS (
        SELECT 1 FROM pg_auth_members m
        JOIN pg_roles member_role ON member_role.oid = m.member
        WHERE member_role.rolname = runtime_name
      ) THEN
        RAISE EXCEPTION 'runtime role % must not be a member of another role', runtime_name;
      END IF;
      EXECUTE format('REVOKE ALL ON TABLE public.api_mutation_idempotency FROM %I', runtime_name);
      EXECUTE format('REVOKE INSERT (office_id,user_id,idempotency_key,resource_type,operation,request_fingerprint,resource_id,response_status,response_body,response_body_purged,purged_at,completed_at,created_at) ON TABLE public.api_mutation_idempotency FROM %I', runtime_name);
      EXECUTE format('REVOKE UPDATE (office_id,user_id,idempotency_key,resource_type,operation,request_fingerprint,resource_id,response_status,response_body,response_body_purged,purged_at,completed_at,created_at) ON TABLE public.api_mutation_idempotency FROM %I', runtime_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) TO %I', runtime_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text) TO %I', runtime_name);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text) TO %I', runtime_name);
      EXECUTE format('REVOKE ALL ON SCHEMA dadban_private FROM %I', runtime_name);
      EXECUTE format('REVOKE ALL ON TABLE dadban_private.api_mutation_idempotency_hmac_key FROM %I', runtime_name);
    END IF;
  END LOOP;
END
$runtime_grants$;

COMMIT;
