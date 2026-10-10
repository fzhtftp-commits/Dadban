-- Dadban RLS rollout preflight (READ-ONLY)
-- Run in Supabase SQL Editor before any RLS or role changes.
-- This script intentionally makes no database changes.

-- 1) Effective SQL Editor role. This is NOT automatically the Render backend role.
select
  current_user,
  session_user,
  r.rolsuper,
  r.rolbypassrls,
  r.rolcanlogin
from pg_roles r
where r.rolname = current_user;

-- 2) RLS enabled/forced state and policy counts for Dadban public tables.
select
  n.nspname as schemaname,
  c.relname as tablename,
  pg_get_userbyid(c.relowner) as table_owner,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  count(p.policyname)::int as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p
  on p.schemaname = n.nspname
 and p.tablename = c.relname
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
  and c.relname in (
    'offices', 'users', 'clients', 'cases', 'hearings',
    'audit_logs', 'auth_credentials', 'auth_sessions'
  )
group by n.nspname, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity
order by c.relname;

-- 3) Existing policies and their expressions.
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'offices', 'users', 'clients', 'cases', 'hearings',
    'audit_logs', 'auth_credentials', 'auth_sessions'
  )
order by tablename, policyname;

-- 4) Relevant database roles and whether they can bypass RLS.
-- Does not expose credentials.
select rolname, rolsuper, rolbypassrls, rolcanlogin
from pg_roles
where rolname in ('postgres', 'authenticated', 'anon', 'service_role')
   or rolname ilike '%dadban%'
order by rolname;

-- 5) Runtime privileges currently granted to the active SQL role on app tables.
-- These are SQL Editor privileges, not necessarily Render's effective privileges.
select
  table_name,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee = current_user
  and table_name in (
    'offices', 'users', 'clients', 'cases', 'hearings',
    'audit_logs', 'auth_credentials', 'auth_sessions'
  )
order by table_name, privilege_type;

-- 6) Verify the cross-office constraints created by the earlier migration.
select
  conname,
  convalidated,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conname in (
  'cases_client_same_office_fk',
  'auth_sessions_user_same_office_fk'
)
order by conname;
