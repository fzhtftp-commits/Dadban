-- Dadban database foundation
-- PostgreSQL 15+
-- Security principles:
-- 1) UUID primary keys
-- 2) UTC timestamps
-- 3) soft delete for business records
-- 4) unique constraints scoped to office
-- 5) no passwords or authentication secrets in business tables
-- 6) ownership/office isolation enforced by the API and, when deployed,
--    PostgreSQL Row Level Security (RLS)

create extension if not exists pgcrypto;

create table if not exists offices (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  office_id uuid references offices(id) on delete restrict,
  full_name varchar(160) not null,
  email varchar(320) not null,
  role varchar(40) not null default 'admin'
    check (role in ('owner','admin','lawyer','assistant','viewer')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists users_email_unique_active
  on users (lower(email))
  where deleted_at is null;

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references offices(id) on delete restrict,
  client_type varchar(20) not null
    check (client_type in ('individual','company')),
  full_name varchar(160),
  national_id varchar(10),
  birth_date date,
  occupation varchar(160),
  company_name varchar(240),
  national_company_id varchar(20),
  registration_no varchar(40),
  mobile varchar(20),
  phone varchar(30),
  email varchar(320),
  source varchar(80),
  address text,
  notes text,
  status varchar(30) not null default 'active'
    check (status in ('active','needs_followup','inactive')),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint clients_individual_fields check (
    (client_type = 'individual'
      and full_name is not null
      and national_id is not null
      and company_name is null
      and national_company_id is null)
    or
    (client_type = 'company'
      and company_name is not null
      and national_company_id is not null
      and full_name is null
      and national_id is null)
  )
);

create unique index if not exists clients_national_id_unique
  on clients (office_id, national_id)
  where client_type = 'individual'
    and national_id is not null
    and deleted_at is null;

create unique index if not exists clients_company_id_unique
  on clients (office_id, national_company_id)
  where client_type = 'company'
    and national_company_id is not null
    and deleted_at is null;

create index if not exists clients_office_status_idx
  on clients (office_id, status)
  where deleted_at is null;

create index if not exists clients_name_idx
  on clients (office_id, full_name)
  where deleted_at is null;

create index if not exists clients_company_name_idx
  on clients (office_id, company_name)
  where deleted_at is null;

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  office_id uuid references offices(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  action varchar(40) not null,
  entity_type varchar(60) not null,
  entity_id uuid,
  metadata jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_office_created_idx
  on audit_logs (office_id, created_at desc);

create index if not exists audit_logs_entity_idx
  on audit_logs (entity_type, entity_id, created_at desc);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists offices_set_updated_at on offices;
create trigger offices_set_updated_at before update on offices
for each row execute function set_updated_at();

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at before update on users
for each row execute function set_updated_at();

drop trigger if exists clients_set_updated_at on clients;
create trigger clients_set_updated_at before update on clients
for each row execute function set_updated_at();

-- RLS policies will be added together with the authenticated API context.
