# Audit-log integrity and retention review

Status: review finding; no production database was accessed or changed.

## Current protections observed in the reviewed branch

- The Supabase security migration enables row-level security on `public.audit_logs`.
- The `anon` role receives no table privileges; `authenticated` receives `INSERT` only.
- The `audit_logs_insert_same_office` policy constrains inserts to the authenticated user's office and user ID.
- The backend writes audit rows for registration, login, logout, and client, case, hearing, case-action, and case-document create/update/delete operations (18 state-changing API routes in this branch).
- The `last_seen_at` session heartbeat is operational telemetry, not a business mutation; it is scoped by session, user, office, and non-revoked state, and a missing/revoked session is rejected. It deliberately does not emit an audit row on every authenticated request.
- The schema uses `ON DELETE SET NULL` for audit-log references to offices and users, so referenced business identities can be detached while the audit row remains.

## Findings and boundaries

1. **Authenticated-role mutation guard:** the SQL migration does not grant `SELECT`, `UPDATE`, or `DELETE` on audit logs to `authenticated`. The disposable PostgreSQL test checks these effective table privileges and now also attempts an actual update and delete, requiring both to be rejected.
2. **Privileged database access:** these controls do not make the table cryptographically tamper-evident. A table owner, superuser, or sufficiently privileged service/migration role may be able to alter or remove records. The actual production role memberships and ownership were not inspected because no operational connection was made.
3. **Retention/archival is undefined:** the reviewed schema, migrations, API routes, and workflows do not define a retention period, archive/export process, purge schedule, or legal-hold procedure. No duration is selected here; that requires an explicit legal/business decision before an automated purge or archive job is implemented.
4. **Recovery/independent evidence:** no immutable external copy or tamper-evident chain was identified in the reviewed files. If audit records must withstand privileged database tampering, evaluate restricted separate storage and/or signed/hash-chained exports as a separate design task.

## Decision required before implementing retention

- Required retention duration and the event that starts the clock.
- Whether legal holds suspend deletion.
- Who may authorize archival or destruction and how that authorization is itself audited.
- Whether records must be exportable and recoverable for investigations.
- Whether personal data in metadata, IP addresses, and user-agent strings needs minimization or a distinct retention schedule.

Until those decisions are approved, preserve existing records and do not introduce automatic deletion.

## Event coverage and metadata review (2026-10-15)

- The reviewed 18 state-changing API routes (registration, login, logout, and create/update/delete for clients, cases, hearings, case actions, and case-document metadata) call `writeAuditLog` before committing their transaction. For the audited operations, an audit INSERT failure is intended to roll back the business change.
- Authentication events record registration, successful login, logout, and failed login attempts. Failed-login events are written after the login transaction is rolled back, with null office/user/entity references and only the fixed reason `invalid_credentials` in metadata; submitted email, password, and token material are not stored. IP and User-Agent remain separately stored request fields and need an approved retention/minimization policy. If the independent audit insert fails, the client still receives the same generic 401; the failed event may therefore be absent during an audit-storage outage.
- Metadata is limited to event context, enumerated status values, confidentiality transitions, and changed field names. Case creation does not copy `case_number`; relationship UUIDs (`client_id` / `case_id`) are also omitted because the audited entity ID and office-scoped business records already provide the relationship context. The reviewed call sites do not pass full request payloads or credential/token values to the audit helper. The helper still records request IP and User-Agent; assess those fields under the approved privacy and retention policy.
- The SQL security workflow checks effective table privileges for `anon` and `authenticated`, verifies RLS and the same-office INSERT policy, accepts a valid same-office INSERT, and rejects cross-office INSERT, UPDATE, and DELETE. This tests the Supabase `authenticated` role in disposable PostgreSQL, not the configured runtime role of the Node backend.
- Regression tests check all 18 state-changing routes at source level, including audit-before-commit, rollback paths, metadata minimization, absence of an API audit-log read route, and the session heartbeat exception. Source-contract checks complement, but do not replace, database integration tests.
- Runtime-role memberships/ownership and production RLS behavior remain unverified: no operational database was accessed. If the backend connects using a table owner, superuser, or a role with `BYPASSRLS`, the Supabase RLS policy is not a substitute for the backend's office-scoped SQL predicates.

## Read-query and office-isolation review (2026-10-15)

- Reviewed authenticated resource GET handlers in `backend/src/server.js`: dashboard, client list/lookup/detail, case list/detail, hearing list/detail, action assignees/list/detail, and case-document list/detail (13 routes). Each derives the office from `req.auth.officeId` and includes a parameterized `office_id` predicate. Joined client/case/action/document relationships are also constrained to matching office IDs where applicable.
- `GET /api/auth/me` returns the authenticated session context established by `requireAuth`; health endpoints are intentionally public and do not return office business records. No `audit_logs` read endpoint was found in the reviewed API routes.
- `requireAuth` resolves the session by token hash and rejects revoked/expired sessions and inactive/deleted users. The `auth_sessions` to `users` office relationship must continue to be enforced by the validated composite foreign key in the schema; the runtime query itself does not add an explicit `s.office_id = u.office_id` join predicate.
- The two-office HTTP integration test now exercises client list/detail and national-ID lookup, case list/detail, hearing list/detail, action list/detail, and action-assignee listing for both offices. It asserts own-office visibility, cross-office list exclusion, and 404 for cross-office detail/lookup. Existing case-document HTTP isolation tests remain in place. The `audit-coverage.test.js` contract test also checks the 13 protected read handlers for an authenticated-office parameter and same-office joins; this static check complements, but does not replace, the HTTP/database integration test.
- The backend configuration reads `DATABASE_URL` from the process environment and uses a PostgreSQL connection pool. `backend/.env.example` leaves the value blank; no production secret value, effective `current_user`, role memberships, table ownership, or `BYPASSRLS` state is exposed by the reviewed files. The operational connection role therefore remains unverified. Do not infer it from the Supabase `authenticated` policy tests.
