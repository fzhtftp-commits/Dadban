# Case-document access control and pre-merge checklist

Status: **Draft / not approved for merge**  
Scope: case-document metadata only. This checklist does not authorize file uploads, downloads, production migration, or deployment.

## Current verified baseline

- Pull request: [#4](https://github.com/fzhtftp-commits/Dadban/pull/4)
- Head branch: `feature/case-documents-metadata`
- Base branch: `feature/case-actions`
- Verified code/test head before this documentation refresh: `64e90f6c0e7e7541c337714cde144c846481de92`
- GitHub Actions run #104: [success](https://github.com/fzhtftp-commits/Dadban/actions/runs/38594257374). Its `head_sha` exactly matches code/test head `64e90f6c0e7e7541c337714cde144c846481de92`.
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

## Role authorization policy — product decision recorded

Approved policy for case-document metadata CRUD:

| Role | List | Read | Create | Update | Soft-delete |
|---|---|---|---|---|---|
| `owner` | Allow | Allow | Allow | Allow | Allow |
| `admin` | Allow | Allow | Allow | Allow | Allow |
| `lawyer` | Allow | Allow | Allow | Allow | Deny |
| `assistant` | Allow | Allow | Allow | Deny | Deny |
| `viewer` | Allow | Allow | Deny | Deny | Deny |

Implementation notes:
- The role vocabulary is defined in `database/schema.sql`: `owner`, `admin`, `lawyer`, `assistant`, `viewer`.
- `requireAuth` verifies a valid, unexpired, unrevoked session and an active, non-deleted user; it puts the server-loaded role in `req.auth.role`.
- A central `requireDocumentRole(...allowedRoles)` middleware now returns HTTP 403 with `{ error: "document_role_forbidden" }` for roles not permitted on that operation.
- List/read allow all five known roles. Create allows owner/admin/lawyer/assistant. Update allows owner/admin/lawyer. Soft-delete allows owner/admin only.
- Office isolation remains independently enforced in SQL using the authenticated session's `officeId`; role permission never overrides office boundaries.
- Integration coverage now seeds accounts for all five roles and exercises positive and negative list/read/create/update/delete outcomes. The latest run must pass before this policy is treated as CI-verified.

## Pre-merge checklist

### Automated checks
- [x] GitHub Actions run #104 passed on code/test head `64e90f6c0e7e7541c337714cde144c846481de92`; a new CI run is required for this documentation refresh.
- [x] Unit tests, JavaScript syntax checks, migration checks, two-office HTTP integration tests, and all five role/action matrix cases passed on that exact SHA.
- [ ] After this checklist update, verify the new branch head and its own Actions result before marking CI current again.
- [x] Add positive and negative role/action integration tests for all five roles; confirm the latest CI run passes on the exact current head SHA.
- [ ] Regression coverage remains for session expiry/revocation, Origin/CSRF failures, office isolation, soft deletion, audit atomicity, idempotency/replay, rollback failure, pool-client reuse, connection acquisition failure, sequential requests, and concurrent requests.
- [ ] Tests run only against a dedicated disposable local/test database; they must not reset or migrate an operational database.

### Human review
- [ ] Review the complete diff and confirm the PR base is still `feature/case-actions`, not `main`.
- [x] Case-document office/user identity is derived from authenticated server-side context, not from request body/query parameters, in the reviewed route handlers.
- [x] Reviewed list/detail/create/update/delete route predicates constrain document access to the authenticated office; two-office HTTP integration tests passed on the reviewed SHA.
- [x] Record the approved role-permission policy and implement the central route guard; final CI verification remains pending.
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
- The product-approved role-permission policy is recorded above and implemented with route guards; merge remains blocked until the latest exact-SHA CI result and remaining human review items are complete.
- Remaining blockers include human role-policy review, schema/migration review, staging verification, deployment-topology validation, and explicit pre-merge approval.
