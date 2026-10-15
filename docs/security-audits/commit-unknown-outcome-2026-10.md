# Audit: unknown transaction outcome at COMMIT and safe retries

- Repository: `fzhtftp-commits/Dadban`
- Baseline commit: `ecdad6031eb7c5e9fefe0d1b9993c4f1e6fdef3e`
- Scope: case-document create/update/confidentiality-change/delete and audit-log atomicity.
- Status: **audit findings / test plan only; not a claim that fault-injection tests have passed**.

## Verified baseline

The baseline's GitHub Actions run for the exact commit completed successfully (run 455, ID 38796312066). This proves only that the configured workflow passed; it does not establish behavior under a lost COMMIT response.

The create endpoint accepts an `Idempotency-Key`, stores a request fingerprint on `case_documents`, uses a unique index over `(office_id, created_by, idempotency_key)`, and on a matching replay returns the existing document without writing a second `create` audit row. A mismatched fingerprint is rejected with `409 idempotency_key_reused`. The create audit insert and the document insert are issued in the same transaction.

The update and delete endpoints currently do not implement a request idempotency key or a durable replay-result record. They perform the mutation and audit insert in one transaction, then commit. If the response is lost after a successful commit, retrying an update can apply the update and write another audit event; retrying a delete can instead return 404 even though the first request succeeded. This is a gap in replay semantics, not proof that transaction atomicity itself is broken.

The current catch path attempts rollback after errors, including a possible error returned by COMMIT. A rollback attempt after a lost connection cannot establish whether the server committed. The connection must be discarded if unusable, and the caller must treat the outcome as unknown until it resolves the durable idempotency record or retries with the same key.

## Required fault-injection matrix

Run against an isolated PostgreSQL instance and an HTTP/API harness; do not run against production data.

1. **Commit succeeded, response dropped:** allow PostgreSQL COMMIT to complete, then drop the connection before the HTTP response reaches the caller. Retry with the same key and identical request.
   - Exactly one document row.
   - Exactly one matching create audit row.
   - Replay returns the original document and marks the response as replay.
2. **Transaction aborted before commit:** terminate the backend or force rollback before COMMIT succeeds; retry with the same key.
   - No partial document/audit row from the aborted transaction.
   - Exactly one document and one create audit row after the successful retry.
3. **Concurrent duplicate create:** send the same key and fingerprint concurrently.
   - Exactly one committed document and one create audit row; loser resolves to the same result or a bounded, documented retryable response.
4. **Same key, different payload:** replay with changed normalized payload.
   - 409; original row and audit row unchanged.
5. **Update and confidentiality change:** simulate a successful commit followed by lost response; retry with the same key.
   - Durable replay result, no second mutation/audit event.
6. **Delete:** simulate a successful commit followed by lost response; retry with the same key.
   - Replay resolves to the original successful outcome rather than a misleading 404; one delete audit event.
7. **Audit insert fails:** force the audit insert to fail.
   - Business mutation rolls back; no business row change without its required audit event.
8. **Connection disposal:** after a simulated connection/protocol failure, verify the broken client is not returned to the pool as healthy.

## Design requirements before marking the issue fixed

- Generalize idempotency to all requested mutation routes using a durable table or equivalent unique operation record keyed by office, actor, route/resource, and client-supplied key.
- Persist a canonical request fingerprint and the final replayable outcome in the same database transaction as the mutation and audit insert.
- Enforce uniqueness in PostgreSQL; do not rely on process-local maps or in-memory locks.
- Reauthorize the actor and enforce office/resource scope on both initial execution and replay. Do not disclose a stored response if access has since been revoked.
- Reject reuse of a key with a different fingerprint.
- Distinguish known transaction aborts from unknown COMMIT outcomes. Never claim rollback merely because the client received an error.
- Keep audit event creation inside the same transaction as the business mutation; retries must resolve to the existing operation rather than append a second event.
- Add deterministic integration tests that verify database row counts and audit event counts, not just source-code patterns.

## Acceptance criteria

The work is not complete until the fault-injection tests run in CI against PostgreSQL, all cases pass, the PR head SHA is verified against the actual workflow result, and the PR remains draft/unmerged pending review. This report intentionally leaves all legal/business data untouched and does not change the default branch.
