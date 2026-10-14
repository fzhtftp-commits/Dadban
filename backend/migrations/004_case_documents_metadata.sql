-- Metadata only. No file/object storage is configured by this migration.
-- Review and apply manually only in disposable/development environments.
create table if not exists case_documents (
 id uuid primary key default gen_random_uuid(), office_id uuid not null references offices(id), case_id uuid not null,
 title varchar(200) not null,
 document_type varchar(32) not null default 'other' check (document_type in ('petition','contract','evidence','court_order','correspondence','identity','receipt','other')),
 description varchar(3000), original_filename varchar(255), mime_type varchar(127),
 size_bytes bigint check (size_bytes is null or (size_bytes >= 0 and size_bytes <= 26214400)),
 document_date date, reference_number varchar(100),
 storage_status varchar(24) not null default 'metadata_only' check (storage_status in ('metadata_only','pending_storage','stored','quarantined')),
 storage_key text, created_by uuid not null, updated_by uuid not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
 constraint case_documents_case_same_office_fk foreign key (case_id, office_id) references cases(id, office_id),
 constraint case_documents_created_by_same_office_fk foreign key (created_by, office_id) references users(id, office_id),
 constraint case_documents_updated_by_same_office_fk foreign key (updated_by, office_id) references users(id, office_id),
 constraint case_documents_storage_metadata_consistency check ((storage_status = 'metadata_only' and storage_key is null) or storage_status <> 'metadata_only')
);
create index if not exists case_documents_office_case_created_idx on case_documents (office_id, case_id, created_at desc) where deleted_at is null;
create index if not exists case_documents_office_created_idx on case_documents (office_id, created_at desc) where deleted_at is null;
