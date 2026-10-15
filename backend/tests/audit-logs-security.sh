#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=localhost}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=dadban_audit_security_test}"
export PGHOST PGUSER PGDATABASE

psql -v ON_ERROR_STOP=1 <<'SQL'
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END
$roles$;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE public.offices (
  id uuid PRIMARY KEY,
  deleted_at timestamptz
);
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  office_id uuid NOT NULL REFERENCES public.offices(id),
  auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  deleted_at timestamptz
);
CREATE TABLE public.clients (
  id uuid PRIMARY KEY,
  office_id uuid NOT NULL REFERENCES public.offices(id),
  deleted_at timestamptz,
  created_by uuid,
  updated_by uuid
);
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid REFERENCES public.offices(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  action varchar(40) NOT NULL,
  entity_type varchar(60) NOT NULL,
  entity_id uuid,
  metadata jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.offices(id) VALUES
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002');
INSERT INTO auth.users(id) VALUES
 ('20000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000002');
INSERT INTO public.users(id, office_id, auth_user_id) VALUES
 ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001'),
 ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002');
SQL

psql -v ON_ERROR_STOP=1 -f ../supabase/migrations/0002_security_rls.sql

psql -v ON_ERROR_STOP=1 <<'SQL'
DO $assert_privileges$
BEGIN
  IF has_table_privilege('anon', 'public.audit_logs', 'SELECT')
     OR has_table_privilege('anon', 'public.audit_logs', 'INSERT')
     OR has_table_privilege('anon', 'public.audit_logs', 'UPDATE')
     OR has_table_privilege('anon', 'public.audit_logs', 'DELETE') THEN
    RAISE EXCEPTION 'anon unexpectedly has audit_logs privileges';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated must retain INSERT on audit_logs';
  END IF;
  IF has_table_privilege('authenticated', 'public.audit_logs', 'SELECT')
     OR has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.audit_logs', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated unexpectedly has SELECT/UPDATE/DELETE on audit_logs';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.audit_logs'::regclass) THEN
    RAISE EXCEPTION 'RLS must be enabled on audit_logs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='audit_logs'
      AND policyname='audit_logs_insert_same_office'
      AND cmd='INSERT' AND roles @> ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'same-office authenticated INSERT policy is missing';
  END IF;
END
$assert_privileges$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',false);
INSERT INTO public.audit_logs(office_id,user_id,action,entity_type)
VALUES ('10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001','create','audit_policy_test');

DO $assert_denied$
BEGIN
  BEGIN
    INSERT INTO public.audit_logs(office_id,user_id,action,entity_type)
    VALUES ('10000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000002','create','cross_office_test');
    RAISE EXCEPTION 'cross-office audit insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_denied$;
RESET ROLE;

DO $assert_rows$
BEGIN
  IF (SELECT count(*) FROM public.audit_logs WHERE entity_type='audit_policy_test') <> 1 THEN
    RAISE EXCEPTION 'valid same-office audit insert was not persisted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_type='cross_office_test') THEN
    RAISE EXCEPTION 'cross-office audit row was persisted';
  END IF;
END
$assert_rows$;

\echo 'PASS: audit_logs grants, RLS insert policy, and cross-office rejection'
SQL
