# Case-document access control and pre-merge checklist

Status: **Draft / not approved for merge**  
Scope: case-document metadata only. This checklist does not authorize file uploads, downloads, production migration, or deployment.

## Current verified baseline

- Pull request: [#4](https://github.com/fzhtftp-commits/Dadban/pull/4)
- Head branch: `feature/case-documents-metadata`
- Base branch: `feature/case-actions`
- Verified head commit at this review: `236f905670f4a98a7bb9b5acf00f1ffacf666e0b`
- GitHub Actions run #94: [success](https://github.com/fzhtftp-commits/Dadban/actions/runs/38591210901). Its `head_sha` exactly matches the PR head SHA above.
- The completed job passed `npm install`, `npm test`, syntax checks for the server/UI, metadata migration and office-isolation checks in disposable PostgreSQL, and two-office HTTP integration checks.
- PR #4 was verified open, Draft, and not merged; its base remains `feature/case-actions`. No production deployment or operational database migration was performed.
- After any new commit, re-check the latest run and require its `head_sha` to equal the current PR head. A green run for an older SHA is not evidence that the current head passed.

## Access-control matrix to verify

| Operation | Required controls | Expected denial cases |
|---|---|---|
| List metadata | Valid, active server-side session; derive office and actor from session; SQL constrained to current office; exclude soft-deleted records | No/expired/revoked session; inactive/deleted user; records from another office |
| Read one record | Same as list; lookup by document ID **and** current office | Unknown ID and another-office ID should not disclose record details |
| Create metadata | Session + trusted Origin + CSRF; strict schema; related case must be in current office; actor/office derived server-side; transaction and audit row | Missing/invalid CSRF or Origin; unknown/cross-office case; invalid fields; duplicate idempotency key with different payload |
| Update metadata | Session + trusted Origin + CSRF; lookup by ID and office; strict patch schema; server-controlled actor/office; transaction and audit row | Cross-office/unknown/deleted record; forbidden fields; empty/invalid patch |
| Soft-delete metadata | Session + trusted Origin + CSRF; ID and office predicate; transaction and audit row | Cross-office/unknown/already-deleted record |
| Future file access (not implemented) | Separate design and security review before implementation: private object storage, authorization on every operation, malware scanning/quarantine, content validation, retention, audit, backup/restore | No public URLs, unauthenticated access, or trust in user-supplied filename/MIME/size |

## Role authorization audit — finding and decision blocker

Observed in `backend/src/server.js` at the reviewed head:

- `requireAuth` verifies a valid, unexpired, unrevoked session and an active, non-deleted user, then copies `users.role` into `req.auth.role`.
- The case-document list/detail/create/update/soft-delete routes are guarded by `requireAuth` (mutations also require trusted Origin and CSRF), and their SQL is scoped by `req.auth.officeId`.
- No role-specific authorization guard or role comparison was found on these five case-document routes. Therefore, the code currently enforces authentication and office boundaries, but does **not** establish different document permissions for different roles. This is an observation about the code, not a claim that any particular role should or should not be allowed.
- Existing two-office integration coverage validates office isolation, but the fixture uses the default `owner` role; it does not prove an authorization policy across all actual roles.
- Do not add a guessed allow/deny list. Before merge, confirm the real role vocabulary from the application schema and obtain an explicit product decision for list/read/create/update/delete permissions for each role. Then implement the policy centrally and add positive and negative tests for every role/action pair, including cross-office cases.

## Pre-merge checklist

### Automated checks
- [x] Latest GitHub Actions run #94 is successful and its `head_sha` equals the reviewed PR head SHA `236f905670f4a98a7bb9b5acf00f1ffacf666e0b`.
- [x] Unit tests, JavaScript syntax checks, migration checks, and two-office HTTP integration tests passed on that exact SHA.
- [ ] After this checklist update, verify the new branch head and its own Actions result before marking CI current again.
- [ ] Add role/action authorization tests after the policy is decided; current passing CI does not establish role-based permissions.
- [ ] Regression coverage remains for session expiry/revocation, Origin/CSRF failures, office isolation, soft deletion, audit atomicity, idempotency/replay, rollback failure, pool-client reuse, connection acquisition failure, sequential requests, and concurrent requests.
- [ ] Tests run only against a dedicated disposable local/test database; they must not reset or migrate an operational database.

### Human review
- [ ] Review the complete diff and confirm the PR base is still `feature/case-actions`, not `main`.
- [x] Case-document office/user identity is derived from authenticated server-side context, not from request body/query parameters, in the reviewed route handlers.
- [x] Reviewed list/detail/create/update/delete route predicates constrain document access to the authenticated office; two-office HTTP integration tests passed on the reviewed SHA.
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
- The current role-permission policy is not defined by the reviewed routes; product decision and role/action test coverage are required before merge.
- Remaining blockers include human role-policy review, schema/migration review, staging verification, deployment-topology validation, and explicit pre-merge approval.
