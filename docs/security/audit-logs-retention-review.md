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
- Authentication events record registration, successful login, logout, and failed login attempts. Failed-login events are written after the login transaction is rolled back, with null office/user/entity references and only the fixed reason `invalid_credentials` in metadata; submitted email, password, and token material are not stored. IP remains stored as PostgreSQL `inet`; User-Agent is now truncated to at most 512 characters before insertion. These are still personal/request metadata: the retention duration and access policy require an explicit legal/business decision. No automatic purge is introduced without that decision. If the independent audit insert fails, the client still receives the same generic 401; the failed event may therefore be absent during an audit-storage outage.
- Login/register throttles currently use an in-process memory map: login allows 10 attempts per 15 minutes per observed source IP, registration 5 per 15 minutes, and document writes 20 per 15 minutes. The map is bounded to 10,000 keys, but entries can be evicted under churn, and counters reset on process restart and are not shared across multiple backend instances. This is a useful single-process guard, not a distributed brute-force control. Before multi-instance production use, move counters to a shared store with atomic increments/expiry and configure trusted proxy hops only when the edge overwrites forwarding headers and direct backend access is blocked. Requests rejected by the login limiter return 429 before the login handler and do not create `login_failed` rows; avoid persisting every blocked request without a volume/retention decision.
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

## Shared rate-limit options review (2026-10-15)

Scope: the reviewed `feature/unified-case-documents-metadata-only-2026-10` branch at baseline `40a9e27c0c149c74468dfcb1ef4bfb989fc7fa98`. No operational database or Render configuration was accessed or changed.

### Options compared

1. **Keep the current in-process map:** no service or migration cost and lowest latency, but each backend instance has independent counters; restart/eviction resets enforcement. This remains a single-instance defense only and must not be represented as a shared production control.
2. **Use the existing PostgreSQL service:** technically feasible without a paid additional service. A dedicated table can store a keyed digest of the normalized client address and a limiter identifier, with an atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` operation for concurrent increments and a bounded expiry/cleanup strategy. This avoids raw IP as the counter key only if a stable high-entropy HMAC secret is configured and shared by every instance. The table needs narrowly scoped privileges, indexes/constraints, concurrency tests, and a tested cleanup policy. A missing table or secret must not silently fall back to per-process enforcement while claiming distributed protection.
3. **External Redis-compatible store:** atomic counters and TTL are a natural fit and avoid writing high-volume counters into the business database, but add an external dependency, operational configuration, availability/failure-policy decisions, and potentially cost. No provider was selected or connected.
4. **Edge/WAF limits:** useful as an additional coarse layer, but do not replace application-level limits for deployments where the origin can be reached directly. Forwarded client addresses are trustworthy only when a configured proxy overwrites the relevant headers and direct origin access is blocked.

### Decision for this PR

Do **not** switch the application to a purported shared limiter in this review commit. The branch's migration directory currently contains only `004_case_documents_metadata.sql`, which is dedicated to case-document metadata; the reviewed branch does not establish a rate-limit table migration/rollout convention or a configured stable HMAC secret. Adding a PostgreSQL counter query without a safely ordered schema rollout and cross-instance secret configuration could make deployment fail or silently preserve the exact per-process weakness being addressed. Reusing `audit_logs` is rejected: its append-only event semantics and personal-data retention policy are not suitable for mutable, high-volume counters.

Recommended next implementation, after confirming the migration rollout path and configuring one stable secret in the deployment environment: add a separate additive rate-limit migration; use HMAC-SHA-256 over a normalized address with a domain-separated limiter key; perform atomic fixed-window increments in PostgreSQL; return 429 with `Retry-After` from the shared decision; add a bounded, indexed expiry cleanup; test simultaneous increments across independent app instances, window reset, cleanup, missing configuration, and database errors in disposable PostgreSQL. Define fail-closed behavior for login/registration and document writes before implementation: silently falling back to local memory is not acceptable for a feature advertised as shared. The database is already a dependency for these routes, but limiter-specific failure handling still needs explicit tests and a product decision.

Until that follow-up is complete, the existing map remains an explicitly single-process safeguard. Do not treat the current 10/5/20 per-15-minute limits as effective across multiple backend instances.

## Migration/deployment-path verification and shared limiter design (2026-10-15)

Reviewed branch: `feature/unified-case-documents-metadata-only-2026-10`, starting SHA `d7150b7e086aca3410198b228568395a509dba1d`. This is a design review only; no operational database, Render configuration, or secrets were accessed or changed.

### What the repository actually does

- The baseline schema is `database/schema.sql`. `backend/README.md` instructs operators to execute it manually before starting the API.
- `backend/migrations/` contains only `004_case_documents_metadata.sql` on this branch. It is a feature-specific migration with strict catalog preflight and transactional DDL; it is not a general migration runner or migration ledger.
- `.github/workflows/case-documents-tests.yml` starts disposable PostgreSQL 16 for CI, runs `npm test`, and applies the baseline through `backend/tests/case-documents-migration-upgrade.sql` before validating migration 004. This does not establish which schema is currently deployed in Render.
- `backend/package.json` has no migration script; `backend/src/server.js` does not automatically apply migrations. `backend/.env.example` documents `PORT`, `DATABASE_URL`, and `CORS_ORIGIN` only. No stable rate-limit HMAC secret is configured/documented in the visible branch.
- The current rate limiters use independent in-process Maps: registration 5, login 10, and document creation 20 requests per 15 minutes, capped at 10,000 keys. They do not coordinate across instances. `trust proxy` is deliberately false; arbitrary forwarding headers must not be trusted.

### Proposed implementation — design only, not yet enabled

**Migration and rollout.** Add a separate additive migration after 004 (proposed filename `backend/migrations/005_shared_rate_limits.sql`), leaving migration 004 and `audit_logs` untouched. Because there is no general migration runner, do not apply DDL automatically from every app instance at startup. Extend the existing disposable-PostgreSQL migration checks and document an explicit production apply step before shared mode can be enabled.

**Counter table contract.** A dedicated `rate_limit_counters` table should contain only:
- `bucket_name` restricted to known limiter names;
- `key_digest bytea` with a 32-byte check (HMAC-SHA-256, not raw IP/account data);
- aligned `window_start timestamptz`;
- positive `request_count integer`;
- `expires_at timestamptz`;
- primary/unique key `(bucket_name, key_digest, window_start)` and an index on `expires_at`.

No raw IP, email, user-agent, token, payload, or office/user identifier belongs in this counter table. Verify the actual runtime DB role and RLS/privileges before writing grants or policies; do not assume the app role equals the local migration owner.

**Atomic shared decision.** Compute a fixed 900-second window using database time so instances agree on the same window. Use one atomic statement, not read-then-write:

```sql
INSERT INTO rate_limit_counters
  (bucket_name, key_digest, window_start, request_count, expires_at)
VALUES ($1, $2, $3, 1, $4)
ON CONFLICT (bucket_name, key_digest, window_start)
DO UPDATE SET request_count = rate_limit_counters.request_count + 1
RETURNING request_count, window_start, expires_at;
```

The implementation must derive the aligned window from one database-side timestamp and return the window end for `Retry-After`. Keep the existing limits and generic 429 response/headers. Avoid automatic retries after an ambiguous connection failure because they can double-count.

**HMAC and IP canonicalization.** Require a stable high-entropy secret (at least 32 random bytes) supplied via deployment secret configuration, for example `RATE_LIMIT_HMAC_KEY`, shared identically by all instances. Never generate a new key at boot, commit it, log it, or store it in PostgreSQL. Canonicalize IP addresses before HMAC so equivalent IPv6 spellings cannot bypass the same bucket; use a reviewed IP parser or PostgreSQL `host($1::inet)` canonicalization. Derive a domain-separated digest such as `HMAC-SHA-256(secret, "dadban-rate-limit:v1:" + bucket + ":" + canonicalIp)`. Store only the digest. Keep proxy trust disabled unless deployment topology is verified to overwrite forwarding headers and block direct origin access; test forged `X-Forwarded-For`.

**Bounded cleanup.** Use the indexed `expires_at` column and a bounded deletion batch (maximum 500 rows) selected in a CTE ordered by expiry with `FOR UPDATE SKIP LOCKED`. Throttle cleanup attempts per process to avoid running a delete for every request; this throttle must affect only cleanup frequency, not rate-limit correctness. Do not add an unreviewed timer per instance. Expired rows may remain temporarily without changing the decision, but table-growth monitoring/limits must be decided before production.

**Failure policy.** Shared mode must not silently fall back to local Maps. Missing/invalid HMAC configuration should prevent explicit shared mode from starting. If the shared counter cannot decide because of a DB timeout/error, return a sanitized temporary-unavailable response (not a false 429); choose and document fail-closed behavior per route before enabling. Do not expose SQL errors, IPs, key material, or connection details. Do not change live Render settings in this PR.

### Tests to add by extending the existing harness (no duplicate suite)

Use only disposable PostgreSQL in CI. Extend existing migration/API integration scripts where practical:
1. Catalog assertions for exact columns/types, primary key, checks, expiry index and least-privilege grants; rollback and incompatible-table migration tests.
2. Parallel increments through two independent limiter instances (preferably separate Node processes): for limit N, exactly N are allowed and no concurrent update is lost.
3. Window boundary/reset and consistent positive Retry-After using database time.
4. Privacy assertion that rows contain only digest/window/count metadata and no raw IP, email, user-agent, token or payload.
5. IPv6 canonicalization; deterministic handling for invalid/missing address without merging unrelated clients into a shared attacker-controlled key.
6. Bounded cleanup removes no more than 500 expired rows and preserves unexpired rows during concurrent increments.
7. Missing key, timeout and database error behavior; no local fallback and no false 429.
8. Proxy spoofing tests with trust proxy disabled.
9. Preserve existing generic login 401/audit behavior and the existing 5/10/20 per-15-minute limits.

### Go/no-go

Do not enable the shared limiter until migration execution is documented for production, a stable secret is configured on all instances, DB role privileges are verified, cross-instance concurrency tests pass, and failure behavior is approved. Until then, the current runtime remains a single-process safeguard and must not be described as distributed rate limiting.


### Shared PostgreSQL rate limiter implementation status (2026-10-15)

The opt-in implementation is now present on the PR branch, but is **not enabled by default** and has not been applied to any operational database or deployment. New files are `backend/migrations/005_shared_rate_limits.sql`, `backend/src/shared-rate-limiter.js`, and `backend/tests/shared-rate-limit.integration.js`. `backend/src/server.js` selects the PostgreSQL implementation only when `RATE_LIMIT_MODE=postgres`; otherwise the prior in-process limiter remains. Selecting PostgreSQL mode requires `DATABASE_URL` and a stable `RATE_LIMIT_HMAC_KEY` of at least 32 bytes at startup, with no silent memory fallback.

The implementation uses PostgreSQL `host(inet)` to canonicalize the observed source address, HMAC-SHA-256 with a bucket-specific domain-separated message, database-aligned 900-second windows, an atomic UPSERT, a bounded cleanup batch of at most 500 expired rows, and generic 503 behavior for counter-decision failures. CI adds a separate disposable PostgreSQL integration run that races two independently pooled limiter instances, checks exact allowed/rejected totals and IPv6 normalization, and exercises missing-key and database-error handling. The migration-upgrade catalog harness now also checks the counter table's columns, primary key, digest constraint, expiry index, and absence of PUBLIC SELECT.

Manual production migration and runtime-role grants are documented in `backend/README.md`. No Render settings, operational secrets, or production database were changed. Shared production behavior remains **not activated** until CI is green on the final SHA, the real runtime role is verified, and the stable secret and least-privilege grants are configured through the approved operational process.
