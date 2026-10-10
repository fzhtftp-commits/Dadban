-- Dadban: defense-in-depth office isolation constraints
-- Apply once in the Supabase SQL Editor after reviewing the preflight query below.
-- This migration deliberately stops if existing rows cross office boundaries.

do $$
begin
  if exists (
    select 1
    from cases c
    join clients cl on cl.id = c.client_id
    where c.office_id <> cl.office_id
  ) then
    raise exception 'Migration stopped: one or more cases reference a client from another office. Review and repair these rows before retrying.';
  end if;

  if exists (
    select 1
    from auth_sessions s
    join users u on u.id = s.user_id
    where s.office_id <> u.office_id
  ) then
    raise exception 'Migration stopped: one or more sessions have an office_id different from their user. Review and repair these rows before retrying.';
  end if;
end
$$;

-- PostgreSQL requires a unique key matching the referenced composite columns.
create unique index if not exists clients_id_office_unique
  on clients (id, office_id);

create unique index if not exists users_id_office_unique
  on users (id, office_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'cases_client_same_office_fk'
      and conrelid = 'cases'::regclass
  ) then
    alter table cases
      add constraint cases_client_same_office_fk
      foreign key (client_id, office_id)
      references clients (id, office_id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'auth_sessions_user_same_office_fk'
      and conrelid = 'auth_sessions'::regclass
  ) then
    alter table auth_sessions
      add constraint auth_sessions_user_same_office_fk
      foreign key (user_id, office_id)
      references users (id, office_id)
      on delete cascade;
  end if;
end
$$;

-- Verify the constraints after running:
select conname, convalidated
from pg_constraint
where conname in (
  'cases_client_same_office_fk',
  'auth_sessions_user_same_office_fk'
)
order by conname;
