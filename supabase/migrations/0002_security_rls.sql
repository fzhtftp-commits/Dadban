-- Dadban / Supabase security layer
-- Requires the base schema in database/schema.sql.

alter table public.users
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete cascade;

create index if not exists users_auth_user_id_idx
  on public.users(auth_user_id)
  where auth_user_id is not null and deleted_at is null;

create schema if not exists private;

create or replace function private.current_user_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select u.id from public.users u
  where u.auth_user_id = (select auth.uid())
    and u.is_active = true and u.deleted_at is null limit 1;
$$;

create or replace function private.current_office_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select u.office_id from public.users u
  where u.auth_user_id = (select auth.uid())
    and u.is_active = true and u.deleted_at is null limit 1;
$$;

revoke execute on function private.current_user_id() from public;
revoke execute on function private.current_office_id() from public;
grant usage on schema private to authenticated;
grant execute on function private.current_user_id() to authenticated;
grant execute on function private.current_office_id() to authenticated;

alter table public.clients enable row level security;
alter table public.audit_logs enable row level security;
alter table public.users enable row level security;
alter table public.offices enable row level security;

revoke all on table public.clients from anon;
revoke all on table public.audit_logs from anon;
revoke all on table public.users from anon;
revoke all on table public.offices from anon;

grant select, insert, update on table public.clients to authenticated;
grant select on table public.users to authenticated;
grant select on table public.offices to authenticated;
grant insert on table public.audit_logs to authenticated;

drop policy if exists clients_select_same_office on public.clients;
create policy clients_select_same_office on public.clients for select to authenticated
using (office_id = (select private.current_office_id()) and deleted_at is null);

drop policy if exists clients_insert_same_office on public.clients;
create policy clients_insert_same_office on public.clients for insert to authenticated
with check (office_id = (select private.current_office_id()) and created_by = (select private.current_user_id()));

drop policy if exists clients_update_same_office on public.clients;
create policy clients_update_same_office on public.clients for update to authenticated
using (office_id = (select private.current_office_id()) and deleted_at is null)
with check (office_id = (select private.current_office_id()) and updated_by = (select private.current_user_id()));

drop policy if exists users_select_self_office on public.users;
create policy users_select_self_office on public.users for select to authenticated
using (office_id = (select private.current_office_id()) and deleted_at is null);

drop policy if exists offices_select_member on public.offices;
create policy offices_select_member on public.offices for select to authenticated
using (id = (select private.current_office_id()) and deleted_at is null);

drop policy if exists audit_logs_insert_same_office on public.audit_logs;
create policy audit_logs_insert_same_office on public.audit_logs for insert to authenticated
with check (office_id = (select private.current_office_id()) and user_id = (select private.current_user_id()));

-- No DELETE grant is given to authenticated users.
-- Soft-delete is implemented through UPDATE and deleted_at.