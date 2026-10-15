# Audit: unknown COMMIT outcome and safe retries

- Baseline reviewed: `ecdad6031eb7c5e9fefe0d1b9993c4f1e6fdef3e`
- Scope: case-document create/update/confidentiality-change/delete and audit-log atomicity.
- Status: findings and test plan only. No fault-injection test is claimed to have passed.

## Verified observations

The baseline GitHub Actions workflow completed successfully for the exact reviewed SHA (run 455, ID 38796312066). This is not evidence that a lost COMMIT response was tested.

Create accepts an `Idempotency-Key`, stores a request fingerprint, and uses a unique index on `(office_id, created_by, idempotency_key)`. Matching replays return the existing document without a second create audit write; mismatched payloads return 409. Document creation and its audit insert share a transaction.

Update and delete do not currently have equivalent durable replay-result semantics. Retrying an update after a successful commit with a lost response can repeat the mutation and audit event. Retrying a successful delete can return 404, obscuring that the first request committed. The error handler's attempt to roll back after a COMMIT connection error cannot prove that PostgreSQL aborted the transaction.

## Required isolated PostgreSQL fault-injection tests

1. **COMMIT succeeds, HTTP response is dropped:** retry identical create with same key. Assert one document, one create audit row, and replay of the original document.
2. **Transaction aborts before COMMIT:** retry same key. Assert no partial document/audit rows from the aborted transaction and exactly one of each after successful retry.
3. **Concurrent duplicate create:** same actor, office, key, and fingerprint concurrently. Assert one document and one create audit event.
4. **Key reused with different payload:** assert 409 and no changes to the original row or audit.
5. **Update/confidentiality change response lost after commit:** retry same key. Assert durable replay and no duplicate mutation/audit.
6. **Delete response lost after commit:** retry same key. Assert the prior successful outcome is replayed rather than a misleading 404; one delete audit event.
7. **Audit insert failure:** assert the business mutation rolls back with no un-audited change.
8. **Broken connection:** assert the failed client is discarded and not reused as a healthy pool connection.

Tests must verify database row counts and audit-event counts, not merely source patterns. Use synthetic data and a disposable PostgreSQL service only.

## Design requirements

- Add durable idempotency for all in-scope mutations, enforced by PostgreSQL uniqueness rather than process-local memory.
- Store a canonical request fingerprint and replayable outcome in the same transaction as the mutation and audit insert.
- Reauthorize the actor and check office/resource access before returning a stored result; never disclose a replay after access is revoked.
- Reject key reuse with a different fingerprint.
- Treat a lost COMMIT response as an unknown outcome, not proof of rollback. Resolve via the durable idempotency record or a same-key retry.
- Keep audit writes atomic with the business operation and avoid a second audit event on replay.

## Acceptance criteria

Do not mark this issue fixed until fault-injection tests run in CI against PostgreSQL, all assertions pass, and the exact PR head SHA is matched to a successful workflow run. Keep the PR draft and unmerged pending review. This report makes no production database changes.
