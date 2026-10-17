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

## Runtime role and effective privileges

Migration `012_api_mutation_idempotency_tombstone_guards.sql` applies the restricted table/column grants only to the known login names `dadban_document_runtime` and `dadban_document_runtime_ci`, when present. A deployment using another database login receives no implicit access to this table; it must be explicitly granted only the required `SELECT`, reservation-column `INSERT`, and completion-column `UPDATE` privileges. Do not make the runtime login the table owner or a member (directly or through nested roles) of an owner/migrator role that could assume broader privileges or disable the guard triggers. The isolated runtime-role test verifies that a differently named role fails closed and that runtime can read the tombstone markers but cannot update `response_body_purged` or `purged_at`.

## Retention and archive decision

No automatic TTL, scheduled purge, or tombstone deletion is enabled by this change. No duration is selected because the approved legal/operational retention period has not been supplied. Until that policy is approved, response purging is an explicit, authorized maintenance action rather than a time-based job.

Do not delete tombstones merely to reclaim space: removing the uniqueness record would allow a sufficiently late retry with the same key to execute the mutation again. If archival is later approved, the archive must preserve the uniqueness scope (office, user, key), fingerprint, resource/operation, completion status, and purged marker in a form consulted by the replay path. Archive/restore must not create a gap in which the key can be reused.
