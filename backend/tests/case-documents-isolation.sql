\set ON_ERROR_STOP on
create extension if not exists pgcrypto;
create table offices (id uuid primary key);
create table users (
 id uuid not null, office_id uuid not null references offices(id),
 primary key (id), unique (id, office_id)
);
create table cases (
 id uuid not null, office_id uuid not null references offices(id),
 primary key (id), unique (id, office_id)
);
create function set_updated_at() returns trigger language plpgsql as $ begin new.updated_at = now(); return new; end $;
insert into offices(id) values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222');
insert into users(id,office_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222');
insert into cases(id,office_id) values
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','22222222-2222-4222-8222-222222222222');
\ir ../migrations/004_case_documents_metadata.sql
insert into case_documents(office_id,case_id,title,created_by,updated_by)
values ('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','valid same-office document','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
do $$
begin
  begin
    insert into case_documents(office_id,case_id,title,created_by,updated_by)
    values ('11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd','cross-office case','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'FAIL: cross-office case was accepted';
  exception when foreign_key_violation then
    raise notice 'PASS: cross-office case rejected';
  end;
  begin
    insert into case_documents(office_id,case_id,title,created_by,updated_by)
    values ('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','cross-office actor','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'FAIL: cross-office actor was accepted';
  exception when foreign_key_violation then
    raise notice 'PASS: cross-office actor rejected';
  end;
  begin
    insert into case_documents(office_id,case_id,title,size_bytes,created_by,updated_by)
    values ('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','oversized metadata',26214401,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'FAIL: oversized metadata was accepted';
  exception when check_violation then
    raise notice 'PASS: oversized metadata rejected';
  end;
end $$;
