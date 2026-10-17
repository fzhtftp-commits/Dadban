BEGIN;
DO $preflight$
DECLARE role_name text; role_state record;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['dadban_actor_lock_owner','dadban_api_idempotency_owner'] LOOP
    SELECT rolsuper,rolcanlogin,rolcreatedb,rolcreaterole,rolinherit INTO role_state FROM pg_roles WHERE rolname=role_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'required SECURITY DEFINER owner role % is missing',role_name; END IF;
    IF role_state.rolsuper OR role_state.rolcanlogin OR role_state.rolcreatedb OR role_state.rolcreaterole OR role_state.rolinherit THEN
      RAISE EXCEPTION 'SECURITY DEFINER owner % has unsafe role attributes',role_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname=role_name) THEN
      RAISE EXCEPTION 'SECURITY DEFINER owner % must not participate in role memberships',role_name;
    END IF;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['dadban_document_runtime','dadban_document_runtime_ci'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) AND EXISTS (
      SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname=role_name
    ) THEN RAISE EXCEPTION 'runtime role % must not participate in role memberships',role_name; END IF;
  END LOOP;
END
$preflight$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Reconcile stale explicit CREATE grants as well as PUBLIC defaults. A prior
-- deployment may have granted CREATE (possibly with GRANT OPTION) to an
-- unrelated role; those grants must not survive this security boundary.
DO $schema_acl_reset$
DECLARE grantee record;
BEGIN
  FOR grantee IN
    SELECT DISTINCT r.rolname
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
    JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'public'
      AND acl.privilege_type = 'CREATE'
      AND acl.grantee <> n.nspowner
      AND acl.grantee <> 0
  LOOP
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I CASCADE', grantee.rolname);
  END LOOP;
END
$schema_acl_reset$;
REVOKE CREATE ON SCHEMA public FROM dadban_actor_lock_owner;
REVOKE CREATE ON SCHEMA public FROM dadban_api_idempotency_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_actor_lock_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_actor_lock_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_api_idempotency_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_api_idempotency_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $function_acl_reset$
DECLARE fn record; grantee record; runtime_name text;
BEGIN
  FOR fn IN
    SELECT p.oid,p.proowner,expected.owner_name
    FROM (VALUES
      ('public.lock_live_document_actor(uuid,uuid,uuid)'::regprocedure,'dadban_actor_lock_owner'),
      ('public.lock_live_client_parent(uuid,uuid)'::regprocedure,'dadban_actor_lock_owner'),
      ('public.lock_live_case_client(uuid,uuid)'::regprocedure,'dadban_actor_lock_owner'),
      ('public.lock_live_case_parents(uuid,uuid[])'::regprocedure,'dadban_actor_lock_owner'),
      ('public.lock_live_case_reassignment(uuid,uuid,uuid)'::regprocedure,'dadban_actor_lock_owner'),
      ('public.reserve_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,'dadban_api_idempotency_owner'),
      ('public.read_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,text)'::regprocedure,'dadban_api_idempotency_owner'),
      ('public.complete_api_mutation_idempotency(uuid,uuid,uuid,text,text,text,text,uuid,integer,text)'::regprocedure,'dadban_api_idempotency_owner')
    ) expected(oid,owner_name) JOIN pg_proc p ON p.oid=expected.oid
  LOOP
    IF fn.proowner <> (SELECT oid FROM pg_roles WHERE rolname=fn.owner_name) THEN
      RAISE EXCEPTION 'SECURITY DEFINER function % has unexpected owner',fn.oid::regprocedure;
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.oid::regprocedure);
    FOR grantee IN
      SELECT DISTINCT r.rolname FROM aclexplode(coalesce(
        (SELECT p.proacl FROM pg_proc p WHERE p.oid=fn.oid),acldefault('f',fn.proowner)
      )) acl JOIN pg_roles r ON r.oid=acl.grantee
      WHERE acl.privilege_type='EXECUTE' AND r.oid<>fn.proowner
        AND r.rolname NOT IN ('dadban_document_runtime','dadban_document_runtime_ci')
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.oid::regprocedure,grantee.rolname);
    END LOOP;
    FOREACH runtime_name IN ARRAY ARRAY['dadban_document_runtime','dadban_document_runtime_ci'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_name) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.oid::regprocedure,runtime_name);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',fn.oid::regprocedure,runtime_name);
      END IF;
    END LOOP;
  END LOOP;
END
$function_acl_reset$;
COMMIT;
