-- Case document metadata only. No file upload or binary storage is enabled.
create unique index if not exists cases_id_office_unique
  on cases (id, office_id);

create table if not exists case_documents (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references offices(id) on delete restrict,
  case_id uuid not null,
  title varchar(200) not null check (length(btrim(title)) >= 2),
  document_type varchar(32) not null default 'other'
    check (document_type in ('pleading','evidence','contract','correspondence','court_order','identity','other')),
  description text check (description is null or length(description) <= 5000),
  document_date date,
  reference_number varchar(120),
  confidentiality varchar(20) not null default 'confidential'
    check (confidentiality in ('normal','confidential','restricted')),
  storage_status varchar(24) not null default 'metadata_only'
    check (storage_status = 'metadata_only'),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint case_documents_case_same_office_fk
    foreign key (case_id, office_id) references cases(id, office_id) on delete restrict
);

create index if not exists case_documents_office_created_idx
  on case_documents (office_id, created_at desc)
  where deleted_at is null;
create index if not exists case_documents_case_date_idx
  on case_documents (office_id, case_id, document_date desc, created_at desc)
  where deleted_at is null;
drop trigger if exists case_documents_set_updated_at on case_documents;
create trigger case_documents_set_updated_at before update on case_documents
for each row execute function set_updated_at();
