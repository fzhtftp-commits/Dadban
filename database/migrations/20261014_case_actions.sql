-- Dadban case actions / follow-ups.
-- Review and apply only through the approved migration process; this file is not run by CI.
begin;

create unique index if not exists users_id_office_unique
  on users (id, office_id);
create unique index if not exists cases_id_office_unique
  on cases (id, office_id);

create table if not exists case_actions (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references offices(id) on delete restrict,
  case_id uuid not null,
  title varchar(200) not null,
  description text,
  due_at timestamptz,
  status varchar(24) not null default 'todo'
    check (status in ('todo','in_progress','completed','cancelled')),
  priority varchar(20) not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  assigned_to uuid,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint case_actions_case_same_office_fk
    foreign key (case_id, office_id) references cases(id, office_id) on delete restrict,
  constraint case_actions_assignee_same_office_fk
    foreign key (assigned_to, office_id) references users(id, office_id) on delete restrict
);

create index if not exists case_actions_office_due_idx
  on case_actions (office_id, due_at, status)
  where deleted_at is null;
create index if not exists case_actions_case_status_idx
  on case_actions (office_id, case_id, status, due_at)
  where deleted_at is null;

drop trigger if exists case_actions_set_updated_at on case_actions;
create trigger case_actions_set_updated_at before update on case_actions
for each row execute function set_updated_at();

commit;
