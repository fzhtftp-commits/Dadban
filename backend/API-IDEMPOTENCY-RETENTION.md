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
