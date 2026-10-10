# Dadban RLS rollout plan

Status: design only. Do not apply database changes from this document until the API refactor and staging tests are complete.

## Current findings

- The backend connects through `DATABASE_URL` as the Supabase `postgres.<project-ref>` pooler user.
- A Supabase role check returned `current_user = postgres`, `rolbypassrls = true`, `rolsuper = false`, and `rolcanlogin = true`.
- The main API uses a shared `pg.Pool` and performs most tenant filtering with explicit `office_id` predicates.
- Existing RLS status check showed RLS enabled on `offices`, `users`, `clients`, and `audit_logs`, but no policies on those tables. Other application tables had RLS disabled.
- The migration `20261010_office_isolation_constraints.sql` has been run successfully; the two composite foreign keys were reported validated.
- The SQL schema comments explicitly defer RLS until the database role strategy and authenticated API context are finalized.

## Safety rule

Do not enable RLS on additional tables or add policies while the live backend still uses the current `postgres` connection. RLS enabled with no matching policies can deny access to roles subject to RLS; a role with `BYPASSRLS` can bypass the policies. Either outcome can be unsafe or break the app.

## Recommended target design

1. Create a dedicated backend runtime database role with only the table/sequence/function privileges the API needs and with neither superuser nor `BYPASSRLS`.
2. Use transaction-scoped tenant context for every tenant-data operation. Set context with `set_config(..., true)` inside the same transaction and connection that performs the queries; never use a session-level setting on a pooled connection.
3. Define restrictive RLS policies for tenant-owned tables, using the trusted server-side context for the authenticated office. Missing context must deny access. Policies should cover both `USING` and `WITH CHECK` as appropriate.
4. Keep authentication bootstrap narrowly scoped. Login and session resolution occur before the office context is known, and registration creates the first office/user/session. Implement narrowly permissioned database functions or another reviewed bootstrap strategy for these flows rather than granting the runtime role broad cross-office reads.
5. Update the API so all reads, writes, audit logging, and related lookups run with the correct context. Avoid mixing `pool.query` calls and transaction-scoped context for the same request.
6. Review all tenant tables and relationships, including `offices`, `users`, `clients`, `cases`, `hearings`, `audit_logs`, `auth_credentials`, and `auth_sessions`. Authentication secrets must not be exposed to normal application queries.
7. Apply migrations only after tests pass in a separate test project or staging database, then deploy the backend and database changes in a coordinated order with a rollback plan.

## Required test matrix before production

- Office A cannot select, update, delete, or attach Office B's clients/cases/hearings by guessing UUIDs.
- Missing tenant context returns no rows / rejects writes.
- A pooled connection used by Office A cannot leak its context into a later Office B request.
- Registration, login, `/api/auth/me`, logout, session expiry, and CSRF checks still work.
- Audit events are written only under the authenticated office/user.
- Dashboard totals and client/case lookups are scoped to the active office.
- A direct connection using the runtime role cannot bypass RLS or read another office's data.
- Health endpoints continue to work without exposing secrets or business data.

## Next implementation step

Refactor the API and authentication bootstrap on an isolated branch first. Do not merge or deploy this planning branch as a production fix. Keep the current production connection unchanged until the complete role/policy/API sequence is reviewed and tested.
