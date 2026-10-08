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


-- Authentication foundation
-- Password hashes and sessions are kept outside the business users table.
create table if not exists auth_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  password_hash text not null,
  password_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  office_id uuid not null references offices(id) on delete cascade,
  token_hash char(64) not null unique,
  csrf_hash char(64) not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists auth_sessions_user_idx
  on auth_sessions (user_id, revoked_at, expires_at);

create index if not exists auth_sessions_expiry_idx
  on auth_sessions (expires_at);

-- Keep the authentication tables protected from accidental public exposure.
-- RLS can be enabled with policies once the database role strategy is finalized.

-- Case management
create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references offices(id) on delete restrict,
  client_id uuid not null references clients(id) on delete restrict,
  case_number varchar(80) not null,
  title varchar(240) not null,
  case_type varchar(80),
  court_name varchar(200),
  branch_name varchar(120),
  opposing_party varchar(240),
  status varchar(30) not null default 'active'
    check (status in ('active','pending','closed','archived')),
  priority varchar(20) not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  filing_date date,
  next_hearing_at timestamptz,
  description text,
  notes text,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists cases_number_unique_active
  on cases (office_id, case_number)
  where deleted_at is null;

create index if not exists cases_office_status_idx
  on cases (office_id, status)
  where deleted_at is null;

create index if not exists cases_client_idx
  on cases (office_id, client_id)
  where deleted_at is null;

create index if not exists cases_hearing_idx
  on cases (office_id, next_hearing_at)
  where deleted_at is null;

drop trigger if exists cases_set_updated_at on cases;
create trigger cases_set_updated_at before update on cases
for each row execute function set_updated_at();
