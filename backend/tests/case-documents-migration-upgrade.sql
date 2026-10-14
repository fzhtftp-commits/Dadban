\set ON_ERROR_STOP on

-- End-to-end migration rehearsal for a fresh, disposable PostgreSQL database.
-- This script intentionally builds the repository's real baseline schema.
-- Never point this test at a shared or operational database.
\ir ../../database/schema.sql
\ir ../../database/migrations/20261010_office_isolation_constraints.sql
\ir ../../database/migrations/20261014_case_actions.sql

-- Preconditions: verify the exact composite unique keys required by migration 004.
do $$
begin
  if not exists (
    select 1 from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'cases'
      and i.indisunique
      and i.indnkeyatts = 2
      and pg_get_indexdef(i.indexrelid) ilike '%(id, office_id)%'
  ) then
    raise exception 'Missing exact unique index for cases(id, office_id)';
  end if;
  if not exists (
    select 1 from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'users'
      and i.indisunique
      and i.indnkeyatts = 2
      and pg_get_indexdef(i.indexrelid) ilike '%(id, office_id)%'
  ) then
    raise exception 'Missing exact unique index for users(id, office_id)';
  end if;
end $$;

begin;
\ir ../migrations/004_case_documents_metadata.sql
commit;

-- Assert the expected office-scoped foreign keys, checks, and indexes exist.
do $$
declare
  required_name text;
  required_names text[] := array[
    'case_documents_case_same_office_fk',
    'case_documents_created_by_same_office_fk',
    'case_documents_updated_by_same_office_fk',
    'case_documents_storage_metadata_consistency',
    'case_documents_idempotency_pair'
  ];
begin
  foreach required_name in array required_names loop
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.case_documents'::regclass
        and conname = required_name
    ) then
      raise exception 'Missing expected case_documents constraint: %', required_name;
    end if;
  end loop;

  -- Names alone are not sufficient: assert each constraint's actual columns/definition.
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.case_documents'::regclass
      and c.conname = 'case_documents_case_same_office_fk'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) ilike '%FOREIGN KEY (case_id, office_id) REFERENCES cases(id, office_id)%'
  ) then
    raise exception 'Case FK name exists but definition is not office-scoped as expected';
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.case_documents'::regclass
      and c.conname = 'case_documents_created_by_same_office_fk'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) ilike '%FOREIGN KEY (created_by, office_id) REFERENCES users(id, office_id)%'
  ) then
    raise exception 'Created-by FK name exists but definition is incorrect';
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.case_documents'::regclass
      and c.conname = 'case_documents_updated_by_same_office_fk'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) ilike '%FOREIGN KEY (updated_by, office_id) REFERENCES users(id, office_id)%'
  ) then
    raise exception 'Updated-by FK name exists but definition is incorrect';
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.case_documents'::regclass
      and c.conname = 'case_documents_storage_metadata_consistency'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%storage_status = ''metadata_only''%'
      and pg_get_constraintdef(c.oid) ilike '%storage_key IS NULL%'
  ) then
    raise exception 'Storage consistency constraint name exists but definition is incorrect';
  end if;
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'public.case_documents'::regclass
      and c.conname = 'case_documents_idempotency_pair'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%idempotency_key IS NULL%'
      and pg_get_constraintdef(c.oid) ilike '%request_fingerprint IS NULL%'
  ) then
    raise exception 'Idempotency constraint name exists but definition is incorrect';
  end if;

  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='case_documents_idempotency_unique_idx'
    and indexdef ilike '%UNIQUE INDEX%ON public.case_documents USING btree (office_id, created_by, idempotency_key)%'
    and indexdef ilike '%WHERE (idempotency_key IS NOT NULL)%') then
    raise exception 'Missing or unexpected idempotency index definition';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='case_documents_office_case_created_idx'
    and indexdef ilike '%ON public.case_documents USING btree (office_id, case_id, created_at DESC)%'
    and indexdef ilike '%WHERE (deleted_at IS NULL)%') then
    raise exception 'Missing or unexpected office/case listing index definition';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='case_documents_office_created_idx'
    and indexdef ilike '%ON public.case_documents USING btree (office_id, created_at DESC)%'
    and indexdef ilike '%WHERE (deleted_at IS NULL)%') then
    raise exception 'Missing or unexpected office listing index definition';
  end if;
end $$;

-- Isolated failure rehearsal. Existing baseline tables remain in public;
-- migration 004 creates its objects in this disposable probe schema.
create schema migration_rollback_probe;
begin;
set local search_path = migration_rollback_probe, public;
\ir ../migrations/004_case_documents_metadata.sql
do $$
begin
  begin
    raise exception using errcode = 'P0001', message = 'intentional rollback rehearsal failure';
  exception when sqlstate 'P0001' then
    raise notice 'PASS: intentional failure was caught inside rehearsal';
  end;
end $$;
rollback;

do $$
begin
  if to_regclass('migration_rollback_probe.case_documents') is not null then
    raise exception 'Rollback rehearsal failed: case_documents table remains';
  end if;
  if exists (
    select 1 from pg_indexes
    where schemaname='migration_rollback_probe'
      and indexname in (
        'case_documents_idempotency_unique_idx',
        'case_documents_office_case_created_idx',
        'case_documents_office_created_idx'
      )
  ) then
    raise exception 'Rollback rehearsal failed: case_documents index remains';
  end if;
  raise notice 'PASS: transactional rollback removed the table and indexes from the probe schema';
end $$;
drop schema migration_rollback_probe;
