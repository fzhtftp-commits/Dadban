# Audit-log integrity and retention review

Status: review finding; no production database was accessed or changed.

## Current protections observed in the reviewed branch

- The Supabase security migration enables row-level security on `public.audit_logs`.
- The `anon` role receives no table privileges; `authenticated` receives `INSERT` only.
- The `audit_logs_insert_same_office` policy constrains inserts to the authenticated user's office and user ID.
- The backend writes audit rows for client, case, hearing, case-action, and case-document create/update/delete operations.
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

- The reviewed resource mutation routes for clients, cases, hearings, case actions, and case-document metadata call `writeAuditLog` before committing their transaction. This keeps the business mutation and its audit row atomic: an audit insert failure rolls back the business change in these handlers.
- Their current metadata is limited to identifiers, action context, changed field names, document storage status, and confidentiality transitions. The reviewed call sites do not pass the whole request body or credential/token values to the audit helper.
- Registration, login, and logout do not currently write audit rows in the reviewed backend. Whether to audit successful/failed authentication, session creation/revocation, and registration should be explicitly decided; failed-login events in particular need careful rate/volume and privacy handling. This review does not silently expand that event scope.
- A regression test now asserts that each of the 15 resource mutation routes writes an audit row before commit and that audit calls do not serialize request payloads or credential/token values. This is a source-contract test; it complements, but does not replace, integration tests against the database.

