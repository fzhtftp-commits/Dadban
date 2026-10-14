# Case-document access control and pre-merge checklist

Status: **Draft / not approved for merge**  
Scope: case-document metadata only. This checklist does not authorize file uploads, downloads, production migration, or deployment.

## Current verified baseline

- Pull request: [#4](https://github.com/fzhtftp-commits/Dadban/pull/4)
- Head branch: `feature/case-documents-metadata`
- Base branch: `feature/case-actions`
- Baseline commit reviewed: `641513982848a8f931252d3ca5dba1ac7e2d62cc`
- GitHub Actions run #89: [success](https://github.com/fzhtftp-commits/Dadban/actions/runs/38589389408), with the run SHA matching that baseline commit.
- The baseline CI job completed unit tests, syntax checks, migration/office-isolation SQL checks, and two-office HTTP integration checks against disposable PostgreSQL.
- Re-check the head SHA and latest run after any subsequent commit. A green run for an older SHA is not evidence that the current head passed.

## Access-control matrix to verify

| Operation | Required controls | Expected denial cases |
|---|---|---|
| List metadata | Valid, active server-side session; derive office and actor from session; SQL constrained to current office; exclude soft-deleted records | No/expired/revoked session; inactive/deleted user; records from another office |
| Read one record | Same as list; lookup by document ID **and** current office | Unknown ID and another-office ID should not disclose record details |
| Create metadata | Session + trusted Origin + CSRF; strict schema; related case must be in current office; actor/office derived server-side; transaction and audit row | Missing/invalid CSRF or Origin; unknown/cross-office case; invalid fields; duplicate idempotency key with different payload |
| Update metadata | Session + trusted Origin + CSRF; lookup by ID and office; strict patch schema; server-controlled actor/office; transaction and audit row | Cross-office/unknown/deleted record; forbidden fields; empty/invalid patch |
| Soft-delete metadata | Session + trusted Origin + CSRF; ID and office predicate; transaction and audit row | Cross-office/unknown/already-deleted record |
| Future file access (not implemented) | Separate design and security review before implementation: private object storage, authorization on every operation, malware scanning/quarantine, content validation, retention, audit, backup/restore | No public URLs, unauthenticated access, or trust in user-supplied filename/MIME/size |

## Role authorization decision — unresolved

Authentication and office isolation do not by themselves define which roles may create, edit, or delete document metadata. Before merge, product/security review must decide and test permissions for each real application role (for example, office owner, administrator, lawyer, and assistant) based on the actual role model. Do not assume these example labels or their permissions are already enforced. If the intended policy is “all active office members may manage metadata,” record that decision explicitly and add tests for it.

## Pre-merge checklist

### Automated checks
- [ ] Latest GitHub Actions run is successful and its `head_sha` equals the current PR head SHA.
- [ ] Unit tests, JavaScript syntax checks, migration checks, and two-office HTTP integration tests pass on that exact SHA.
- [ ] Regression coverage remains for session expiry/revocation, Origin/CSRF failures, office isolation, soft deletion, audit atomicity, idempotency/replay, rollback failure, pool-client reuse, connection acquisition failure, sequential requests, and concurrent requests.
- [ ] Tests run only against a dedicated disposable local/test database; they must not reset or migrate an operational database.

### Human review
- [ ] Review the complete diff and confirm the PR base is still `feature/case-actions`, not `main`.
- [ ] Confirm office/user identity is always derived from authenticated server-side context, never from request body/query parameters.
- [ ] Review every list/detail/create/update/delete SQL predicate and verify cross-office access is denied without leaking record existence.
- [ ] Decide and implement/verify the role-permission policy described above.
- [ ] Review migration constraints and indexes against the actual baseline schema; verify composite unique keys required by office-scoped foreign keys exist in the target schema.
- [ ] Review the rollback and recovery plan. Confirm a verified backup and a tested restore procedure before any shared-environment migration.
- [ ] Verify production proxy topology before setting `TRUST_PROXY_HOPS`; the ingress must normalize forwarding headers and direct-origin access must be blocked.
- [ ] Decide how rate limiting will work across instances. The current in-process limiter is not a shared multi-instance limiter.
- [ ] Complete a manual browser smoke test in isolated staging with test accounts from two separate offices.
- [ ] Confirm that upload/download endpoints and storage credentials remain absent; metadata values are not evidence that a file exists or is safe.
- [ ] Obtain explicit human review before converting the PR from Draft.

### Deployment and database boundaries
- [ ] Do not apply `004_case_documents_metadata.sql` to production as part of this PR.
- [ ] Do not deploy the UI/backend from this draft branch to the live service as part of CI validation.
- [ ] Do not enable file upload, object storage, public links, or file streaming under this metadata-only scope.
- [ ] Keep PR #4 Draft and unmerged until all applicable checks are complete and reviewed.

## Decision record

- Automated CI passing means the covered tests passed; it is not a complete security audit.
- Remaining blockers include human role-policy review, schema/migration review, staging verification, deployment-topology validation, and explicit pre-merge approval.
