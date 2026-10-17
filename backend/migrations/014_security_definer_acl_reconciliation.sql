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
-- Reconcile every stale ACL on the private HMAC key table, including
-- column-level grants and grant options left by previous deployments.
-- Only the table owner and the non-login proof-function owner may retain
-- access; the latter receives plain SELECT only.
DO $hmac_key_acl_reset$
DECLARE
  table_owner oid;
  grantee record;
  column_row record;
BEGIN
  SELECT c.relowner INTO table_owner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='dadban_private'
    AND c.relname='api_mutation_idempotency_hmac_key'
    AND c.relkind='r';
  IF table_owner IS NULL THEN
    RAISE EXCEPTION 'private API idempotency HMAC key table is missing';
  END IF;

  REVOKE ALL ON TABLE dadban_private.api_mutation_idempotency_hmac_key FROM PUBLIC;
  FOR column_row IN
    SELECT attname FROM pg_attribute
    WHERE attrelid='dadban_private.api_mutation_idempotency_hmac_key'::regclass
      AND attnum > 0 AND NOT attisdropped
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE dadban_private.api_mutation_idempotency_hmac_key FROM PUBLIC',
      column_row.attname
    );
  END LOOP;

  FOR grantee IN
    SELECT DISTINCT r.rolname
    FROM (
      SELECT acl.grantee
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      WHERE c.oid='dadban_private.api_mutation_idempotency_hmac_key'::regclass
      UNION
      SELECT acl.grantee
      FROM pg_attribute a
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
      WHERE a.attrelid='dadban_private.api_mutation_idempotency_hmac_key'::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
    ) grants
    JOIN pg_roles r ON r.oid=grants.grantee
    WHERE grants.grantee <> table_owner
  LOOP
    EXECUTE format(
      'REVOKE ALL ON TABLE dadban_private.api_mutation_idempotency_hmac_key FROM %I CASCADE',
      grantee.rolname
    );
    FOR column_row IN
      SELECT attname FROM pg_attribute
      WHERE attrelid='dadban_private.api_mutation_idempotency_hmac_key'::regclass
        AND attnum > 0 AND NOT attisdropped
    LOOP
      EXECUTE format(
        'REVOKE SELECT (%1$I), INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE dadban_private.api_mutation_idempotency_hmac_key FROM %2$I CASCADE',
        column_row.attname, grantee.rolname
      );
    END LOOP;
  END LOOP;

  REVOKE ALL ON TABLE dadban_private.api_mutation_idempotency_hmac_key FROM dadban_api_idempotency_owner;
  GRANT SELECT ON TABLE dadban_private.api_mutation_idempotency_hmac_key TO dadban_api_idempotency_owner;
END
$hmac_key_acl_reset$;
REVOKE CREATE ON SCHEMA public FROM dadban_actor_lock_owner;
REVOKE CREATE ON SCHEMA public FROM dadban_api_idempotency_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_actor_lock_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_actor_lock_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_api_idempotency_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE dadban_api_idempotency_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- Reconcile stale default EXECUTE ACLs for every schema scope, not only
-- PUBLIC in the global/public scopes. Otherwise a previous deployment can
-- make future SECURITY DEFINER functions executable by arbitrary roles.
DO $default_function_acl_reset$
DECLARE
  default_acl record;
  grantee record;
  owner_name text;
  scope_sql text;
BEGIN
  FOR default_acl IN
    SELECT d.defaclrole, d.defaclnamespace,
           pg_get_userbyid(d.defaclrole) AS owner_name,
           n.nspname AS schema_name
    FROM pg_default_acl d
    LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    WHERE d.defaclobjtype='f'
      AND d.defaclrole IN (
        SELECT oid FROM pg_roles
        WHERE rolname IN ('dadban_actor_lock_owner','dadban_api_idempotency_owner')
      )
  LOOP
    owner_name := default_acl.owner_name;
    scope_sql := CASE WHEN default_acl.defaclnamespace=0 THEN ''
                      ELSE format(' IN SCHEMA %I',default_acl.schema_name) END;
    FOR grantee IN
      SELECT DISTINCT acl.grantee, r.rolname
      FROM pg_default_acl d
      CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
      LEFT JOIN pg_roles r ON r.oid=acl.grantee
      WHERE d.defaclrole=default_acl.defaclrole
        AND d.defaclnamespace=default_acl.defaclnamespace
        AND d.defaclobjtype='f'
        AND acl.privilege_type='EXECUTE'
        AND acl.grantee<>d.defaclrole
    LOOP
      IF grantee.grantee=0 THEN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
          owner_name,scope_sql
        );
      ELSE
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE EXECUTE ON FUNCTIONS FROM %I CASCADE',
          owner_name,scope_sql,grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END
$default_function_acl_reset$;
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
