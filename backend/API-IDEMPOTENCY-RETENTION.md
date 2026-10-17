# API mutation idempotency: response minimization and retention

## Stored response contract

The generic `api_mutation_idempotency` table stores only the stable resource identifier for keyed 200/201 mutations (`{"data":{"id":"…"}}`) and an empty object for 204 responses. The first live HTTP response is unchanged. A successful replay returns the stored status with this minimal body; clients must use the resource ID to fetch current authorized data rather than relying on a second stored copy of client/case/hearing/action fields.

The request fingerprint, resource type, operation, office/user scope, resource ID, status, and completion timestamp are retained to detect a conflicting key and prevent a mutation from being run again.

## Purging a stored response

Migration `011_api_mutation_idempotency_tombstones.sql` adds `response_body_purged` and `purged_at`. Purging removes only the response body and leaves the idempotency row as a tombstone. A matching retry then returns HTTP 410 with `{"error":"idempotency_result_purged"}`; it must not repeat POST, PATCH, or DELETE. A mismatched fingerprint/resource/operation remains a 409 conflict. Authentication and current authorization checks must happen before returning replay/tombstone details.

An authorized maintenance process may purge a selected completed response only after confirming the applicable retention approval. Use a transaction and require exactly one row to be updated:

```sql
BEGIN;

UPDATE public.api_mutation_idempotency
SET response_body = NULL,
    response_body_purged = TRUE,
    purged_at = clock_timestamp()
WHERE office_id = :office_id
  AND user_id = :user_id
  AND idempotency_key = :idempotency_key
  AND completed_at IS NOT NULL
  AND response_body_purged = FALSE;

-- Commit only if exactly one row was updated and the target is the intended record.
-- Otherwise ROLLBACK and investigate.
COMMIT;
```

The parameter placeholders above are illustrative; use parameterized SQL in the maintenance client. Do not log raw request bodies or sensitive identifiers during this operation.

## Security finding: direct database credential can pre-reserve another user's key

**Status: documented limitation; not fixed by this PR.** The HTTP/API path derives `office_id` and `user_id` from the authenticated request context, and tests reject forged scope fields in the request body. That is not equivalent to protecting the database boundary from a caller who has obtained the shared runtime database credential.

The runtime role requires column-level `INSERT` on `api_mutation_idempotency(office_id,user_id,idempotency_key,resource_type,operation,request_fingerprint)`. The table's composite foreign key verifies that the chosen `user_id` belongs to the chosen `office_id`, but it does not verify that the database caller is authenticated as that user. A holder of the runtime credential can therefore insert an **incomplete reservation** for any known, existing user/office pair and choose an idempotency key that user might later need. The uniqueness constraint then blocks that user's legitimate request with the same key; the API sees a matching incomplete row and returns its controlled retryable/incomplete result instead of running the mutation. The restricted column grants prevent that caller from directly inserting a completed response or editing the tombstone markers, but do not prevent this pre-reservation/denial-of-service case.

This is a database-credential compromise/abuse scenario, not an HTTP payload-scope bypass. It does not, by itself, let the caller forge a successful mutation result, but it can reserve another user's key and disrupt that request. The isolated API test for forged `office_id`/`user_id` fields proves only the HTTP boundary and must not be interpreted as proof against direct SQL using the runtime credential.

**Decision:** no small safe database-only fix has been applied in this audit step. Simply moving INSERT into a `SECURITY DEFINER` function while trusting caller-supplied user/office IDs, transaction-local settings, or a caller-selected session identifier would preserve the spoofing problem. A follow-up design must bind reservation to proof of a live authenticated session that the shared database credential cannot forge, then remove direct reservation INSERT privileges and test invalid, revoked, expired, cross-user, and re-login cases. Evaluate this as a separate scoped change; do not claim it is resolved by the current migrations. No production database was queried or modified for this finding.

## Runtime role and effective privileges

Migration `012_api_mutation_idempotency_tombstone_guards.sql` applies the restricted table/column grants only to the known login names `dadban_document_runtime` and `dadban_document_runtime_ci`, when present. A deployment using another database login receives no implicit access to this table; it must be explicitly granted only the required `SELECT`, reservation-column `INSERT`, and completion-column `UPDATE` privileges. Do not make the runtime login the table owner or a member (directly or through nested roles) of an owner/migrator role that could assume broader privileges or disable the guard triggers. The isolated runtime-role test verifies that a differently named role fails closed and that runtime can read the tombstone markers but cannot update `response_body_purged` or `purged_at`.

## Retention and archive decision

No automatic TTL, scheduled purge, or tombstone deletion is enabled by this change. No duration is selected because the approved legal/operational retention period has not been supplied. Until that policy is approved, response purging is an explicit, authorized maintenance action rather than a time-based job.

Do not delete tombstones merely to reclaim space: removing the uniqueness record would allow a sufficiently late retry with the same key to execute the mutation again. If archival is later approved, the archive must preserve the uniqueness scope (office, user, key), fingerprint, resource/operation, completion status, and purged marker in a form consulted by the replay path. Archive/restore must not create a gap in which the key can be reused.

## Additional audit — reservation insertion paths and direct-credential boundary (2026-10-17)

The generic helper `beginApiMutationIdempotency` is the sole direct INSERT path in `backend/src/server.js` for `public.api_mutation_idempotency`. Its call sites are client POST/PATCH, case POST/PATCH, and hearing/case-action POST/PATCH/DELETE. Each call is reached inside the route's transaction after actor/session revalidation; the business write, audit INSERT, and completion UPDATE are intended to commit in that same transaction. A normal API request does not deliberately commit an incomplete reservation: a failed mutation or audit write rolls the transaction back, while a successful operation commits a completed row. Concurrent requests cannot see the uncommitted reservation as a durable incomplete row; they wait for the owning transaction and then observe either its completed row or its rollback.

This transaction invariant does **not** protect against direct SQL performed with the shared runtime credential. Migration 012 grants INSERT on the reservation identity columns, while the table owner remains able to administer the table and its guards. A runtime credential holder can independently insert a syntactically valid, FK-valid incomplete row for a different existing user/office pair. Because the row is committed outside the API's transaction, it survives; the durable-row trigger forbids DELETE, and runtime has no DELETE privilege. A later legitimate request with that user's same key sees `response_status IS NULL` / `completed_at IS NULL` and returns `503 idempotency_result_incomplete` without performing its mutation. This is a persistent key-level denial of service, not evidence that the HTTP body can override `req.auth` scope.

The existing HTTP integration coverage for forged scope fields therefore proves only the HTTP boundary. A meaningful PostgreSQL-isolated regression for a future remediation must run as the effective runtime login, attempt cross-user/cross-office reservation, and verify that the database rejects it; it must also verify legitimate same-session reservation, invalid proof, expired/revoked session, another user's session, and logout/re-login. A function that accepts caller-supplied user/office IDs, transaction-local settings, or a caller-selected session ID is not sufficient, because the runtime caller can forge those inputs. A session-bound design needs a non-forgeable proof of the live session validated inside the privileged database boundary, plus revocation of direct reservation INSERT and least-privilege EXECUTE grants. That requires a coordinated API/schema change and isolated tests; this audit does not claim the gap is fixed. No arbitrary TTL or production-database change is introduced.

## Follow-up design review — proof-bound reservation and completion (2026-10-17)

### Additional direct-credential finding: completion is also forgeable

Migration 012 currently grants the runtime login direct `UPDATE(resource_id,response_status,response_body,completed_at)`. The guard trigger makes a completed result immutable after completion, but it permits the transition from an incomplete row to a completed row when the new row satisfies the table CHECK constraint. A holder of the shared database credential can therefore complete another user's pre-reserved key with a fabricated status/body/resource identifier. A later retry may replay that fabricated result (or a fabricated 410-like response if the row is purged through a separate privileged path). This is distinct from reservation denial-of-service and means removing INSERT alone is not sufficient.

### Recommended trust boundary (design only; not implemented)

1. **Revoke direct INSERT and UPDATE on the generic idempotency table** for runtime logins. Keep only the minimum read access needed by the API, if direct reads remain necessary. The runtime role must not own the table, own the privileged functions, inherit an owner/migrator role, or have permission to disable triggers.
2. Expose narrowly scoped `SECURITY DEFINER` database functions for reserve and complete. Fix each function's `search_path` to trusted schemas, fully qualify object references, revoke EXECUTE from PUBLIC, and grant EXECUTE only to the intended runtime role. The functions should perform the state transition and validate all fields; do not create a generic SQL execution helper.
3. Bind each call to the actual live `auth_sessions` row: session ID, user ID, office ID, non-revoked state, and unexpired state must agree. Validate within the same transaction as the mutation. Do not trust caller-provided IDs or `SET LOCAL` variables as proof; direct SQL callers can forge them.
4. Since the shared runtime credential can call SQL directly, a session ID alone is not proof of an authenticated HTTP request. Use a separate high-entropy application-held HMAC key and a signed assertion over a canonical, domain-separated payload. The database function verifies the assertion using a key stored in a table/schema that the runtime role cannot read, and independently checks the live session. The assertion must bind at least the transition name (`reserve` or `complete`), session/user/office IDs, idempotency key, resource type, operation, request fingerprint, and—for completion—the exact resource ID, status, and permitted minimal response envelope. Define canonical serialization and key rotation explicitly; reject absent, malformed, expired, or mismatched proofs. Do not reuse the session token, CSRF token, or database password as the HMAC key.
5. Prefer having the database derive the minimal replay envelope from validated status/resource ID instead of accepting arbitrary JSON from the caller. Completion must be a one-way transition from pending to completed; identity fields and result identity remain immutable; purging remains one-way and cannot rewrite result identity.
6. A valid assertion must be minted only after the API has authenticated the request and revalidated the same live session. The signature prevents a holder of the database credential alone from fabricating a new assertion, but it does not protect against compromise of the application process or its signing secret. Document that threat boundary rather than claiming protection against total application compromise.

### Required isolated PostgreSQL regression matrix before calling this fixed

Run the tests as the actual runtime login (not the migration/table owner) against a disposable PostgreSQL instance. Verify: direct INSERT denied; direct UPDATE denied; direct DELETE denied; valid signed reservation for the live session succeeds; absent/invalid signature fails; user/office/session mismatch fails; expired and revoked sessions fail; a different user's session fails; a logged-out session followed by re-login cannot reuse the old session proof; replay of a key across resource/operation/fingerprint conflicts; concurrent same-key requests produce one mutation and one stable replay; audit-write failure rolls back mutation and idempotency completion; a forged completion assertion cannot change resource ID/status/body; a valid completion can happen once only; tombstone purge does not reopen or rewrite the result; runtime cannot read signing-key material, alter function ownership, replace functions, or disable triggers. Include effective privilege checks (including role membership and inherited grants) rather than relying only on the migration's intended GRANT statements.

**Status:** this section is a reviewed design proposal, not an implementation or proof of remediation. No schema, API runtime, Render deployment, production database, or `main` branch was changed by this follow-up. Do not mark the issue resolved until the API/schema implementation and all applicable isolated PostgreSQL tests pass on the same SHA.

## Implementation update — proof-bound API idempotency (2026-10-17)

Migration `013_api_mutation_idempotency_proof_functions.sql` and `backend/src/server.js` now route generic API idempotency reservations/completions through the narrowly scoped `reserve_api_mutation_idempotency`, `read_api_mutation_idempotency`, and `complete_api_mutation_idempotency` SECURITY DEFINER functions. The functions have a dedicated `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT` owner, fixed `search_path = pg_catalog, pg_temp`, fully qualified table references, and no PUBLIC EXECUTE. Known runtime roles receive EXECUTE on these three functions but no direct SELECT, INSERT, or UPDATE on `api_mutation_idempotency`. The function owner has only the table and row-lock privileges needed by this protocol and is checked for role memberships.

Each proof is an HMAC-SHA256 over a versioned, delimiter-separated canonical tuple containing transition name, live session ID, user ID, office ID, key, resource type, operation, request fingerprint, and (for completion) resource ID/status. The database independently verifies the HMAC against a secret in `dadban_private.api_mutation_idempotency_hmac_key`, locks the session and user in deterministic order, rechecks that the session is not revoked or expired and that the user is active/not deleted, then performs the one allowed transition. The lookup function locks and reads the existing row inside PostgreSQL, including across concurrent response purging; the completion function derives the minimal replay body inside PostgreSQL instead of accepting caller-supplied JSON. Direct SQL alone cannot mint a valid proof unless the caller also compromises the application-held HMAC secret.

### Required secret provisioning (not performed in this repository change)

Migration 013 intentionally creates the protected singleton key row with `secret = NULL`; this fails closed until provisioned. A deployment operator must use a secret manager to generate a random 32-byte key represented as exactly 64 lowercase hexadecimal characters, set the same value as `API_MUTATION_IDEMPOTENCY_HMAC_KEY` for the API process, and provision the database value through a parameterized query executed by the authorized schema/migration owner:

`UPDATE dadban_private.api_mutation_idempotency_hmac_key SET secret = decode($1, 'hex') WHERE singleton = true`

The query must be executed with the 64-hex secret as a bound parameter, never interpolated into committed SQL, logs, shell history, or this document. Verify exactly one row was updated, verify the runtime role cannot read the key table, and keep the migration/table owner as a trusted privileged principal; the non-login function owner receives only the SELECT privilege needed by the proof functions. Do not deploy the API change until both halves are provisioned consistently. Key rotation is not implemented by migration 013; do not rotate only one side or reuse a session/CSRF/database password as this key.

### Isolated regression coverage added

`backend/tests/case-documents-runtime-role.integration.js` now applies migration 013 only to its guarded localhost disposable database and tests direct INSERT/UPDATE denial, secret-table read denial, invalid reservation/completion proofs, valid one-time completion, completion rewrite rejection, tombstone irreversibility/replay retention, revoked and expired sessions, an old revoked session after re-login, and a session/user mismatch. It also inspects function ownership, SECURITY DEFINER/search_path, PUBLIC EXECUTE, runtime grants, and owner role membership. `backend/tests/audit-mutation-rollback.integration.js` applies migration 013 and provisions only its dedicated disposable database; failed audit writes assert the generic idempotency reservation rolls back with the mutation, while its existing successful replay checks continue to exercise the HTTP API.

**Verification status:** these are code and test changes on the audit branch only. They are not considered fixed until both GitHub Actions runs on the exact resulting SHA finish successfully and the isolated PostgreSQL suite passes. No production key has been provisioned, and no production database, Render service, or `main` branch was touched.

