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


## Migration / index / rollback audit — 2026-10-14

Scope reviewed: `backend/migrations/004_case_documents_metadata.sql`, `backend/tests/case-documents-isolation.sql`, `database/schema.sql`, `database/migrations/20261014_case_actions.sql`, and the branch-scoped workflow. This is a source review plus disposable-PostgreSQL CI evidence, not authorization to apply the migration to a shared or production database.

### Findings

- **Composite office-scoped foreign keys:** the document table ties `(case_id, office_id)` to `cases(id, office_id)`, and `(created_by, office_id)` / `(updated_by, office_id)` to `users(id, office_id)`. This prevents a document from linking to a case or actor in a different office, assuming the referenced composite unique keys exist.
- **Prerequisite/order dependency:** `database/schema.sql` and `database/migrations/20261014_case_actions.sql` define `cases_id_office_unique` and `users_id_office_unique`. Migration `004_case_documents_metadata.sql` depends on those keys but does not create or preflight them itself. Before any use, verify that the approved baseline/preceding migration has been applied in the target environment; do not run this migration against an older schema and assume it is standalone.
- **Coverage limitation in migration test:** `case-documents-isolation.sql` creates simplified fixture tables and their composite unique keys itself before including migration 004. It proves rejection of cross-office case/actor references and over-limit size in that fixture, but does **not** prove that a real upgraded database has the prerequisites in the correct migration order. Add a disposable full-baseline upgrade test before considering this migration release-ready.
- **Indexes:** the partial unique index on `(office_id, created_by, idempotency_key)` protects keyed create retries per office/actor; the partial `(office_id, case_id, created_at DESC)` index supports active documents for a case; and `(office_id, created_at DESC)` supports active office listings. The first listing index also starts with the columns used by the composite case FK. There are no dedicated indexes beginning with `(office_id, created_by)` or `(office_id, updated_by)`; evaluate these if user deletion/update or actor-based reporting becomes a frequent operation, rather than adding indexes without workload evidence.
- **Storage-state consistency:** the check prevents `metadata_only` rows from carrying a storage key, but permits `stored` with a null `storage_key`. Current API scope does not expose storage state or file bytes, so this is not currently a client-write path; before enabling storage, tighten and test the state machine (at minimum, a stored object must have a valid non-empty private storage key).
- **Partial-apply risk:** migration 004 does not contain an explicit transaction wrapper. If the chosen migration runner does not wrap it in a transaction, an error after table creation could leave a partially applied schema. Confirm runner behavior or run it inside an explicit transaction after confirming all statements are transaction-compatible; do not retry blindly after a partial failure. The current CI includes it inside a disposable test transaction, which is not equivalent to testing every deployment runner's behavior.

### Rollback / recovery runbook (not executed)

1. **Before change:** confirm exact target database/environment, migration order, PostgreSQL version, expected schema objects, and a maintenance/read-only window appropriate to the application. Take a verified backup/snapshot and record its identifier and timestamp.
2. **Prove recovery:** restore that backup into a separate disposable database and verify connectivity, row counts, critical constraints, and application smoke tests. A backup that has not been restored successfully is not a verified recovery path.
3. **Preflight:** check that `offices`, `cases`, and `users` exist; confirm the composite unique keys `cases_id_office_unique` and `users_id_office_unique` cover exactly `(id, office_id)`; confirm no same-named index/constraint has a different definition; and inspect for an existing/partial `case_documents` table before applying anything.
4. **Apply only in an approved non-production rehearsal first:** capture the migration output and verify the table, all three composite foreign keys, check constraints, and all three indexes by querying PostgreSQL catalogs. Run same-office success and cross-office rejection cases, idempotency conflict cases, and soft-delete listing checks.
5. **On failure:** stop writes to the new feature and preserve logs. Inspect the catalog to determine exactly which statements committed. If the migration was transactionally rolled back, verify that no new objects remain before retrying. If partial objects remain, compare each object with the migration and repair deliberately; do not use `IF NOT EXISTS` as proof that an existing object has the right definition.
6. **After successful shared-environment migration:** verify constraints are validated, index definitions match, API smoke tests and office-isolation checks pass, and audit records remain intact. Monitor errors before re-enabling normal writes.
7. **Rollback choice:** prefer a forward fix or application feature-flag disablement. Do not automatically `DROP TABLE case_documents` after metadata has been written: that would destroy records. A destructive down migration is only acceptable before any real records exist, after an explicit backup and human approval. If records exist, preserve/export them and plan a reviewed data-preserving recovery.
8. **Current boundary:** no migration was run against production/operational data, no Render deployment was performed, and no rollback/restore has been executed. The runbook is a plan, not evidence of a completed restore drill.

### Required before PR #4 can leave Draft

- [ ] Add CI coverage that builds the actual baseline schema, applies prerequisite migrations in documented order, then applies migration 004 to a fresh disposable PostgreSQL database.
- [ ] Decide and document transaction handling in the migration runner; exercise a forced failure in a disposable database and confirm the resulting schema is fully rolled back or safely recoverable.
- [ ] Add a catalog assertion for every expected FK/check/index, including the exact indexed columns and partial predicates; verify pre-existing same-named objects rather than relying on `IF NOT EXISTS`.
- [ ] Resolve the `stored`/null-`storage_key` invariant before any file-storage capability is introduced.
- [ ] Complete a backup restore rehearsal and have a human reviewer approve the recovery procedure before any shared-environment migration.


## Full-baseline migration upgrade and rollback rehearsal — 2026-10-14

- The previously pending GitHub Actions run #106 completed successfully on the exact then-current head `cbd7e6a3d8e4e3d1d2715b4640b39229bfd5de5f`: [run #106](https://github.com/fzhtftp-commits/Dadban/actions/runs/38595208461).
- Added `backend/tests/case-documents-migration-upgrade.sql` to exercise a fresh disposable PostgreSQL database using the repository's actual `database/schema.sql`, then `database/migrations/20261010_office_isolation_constraints.sql`, then `database/migrations/20261014_case_actions.sql`, followed by `backend/migrations/004_case_documents_metadata.sql`.
- The new test checks exact two-column unique-index prerequisites for `cases(id, office_id)` and `users(id, office_id)`, asserts the expected metadata constraints and index definitions, and performs a separate-schema transaction rollback rehearsal after an intentional test failure. It verifies the probe table and its indexes are absent after rollback.
- Workflow order was changed so this full-baseline rehearsal runs before the HTTP integration test, because that integration test deliberately resets the disposable database to simplified fixtures.
- **Interpretation limit:** the intentional error is raised and caught inside the test transaction to allow deterministic rollback assertions. This verifies PostgreSQL transactional DDL rollback when statements are wrapped in a transaction; it does not prove that every production migration runner automatically wraps migrations or that an out-of-transaction partial failure is recoverable.
- This rehearsal is restricted to the GitHub Actions disposable PostgreSQL service. It does not connect to, migrate, reset, or otherwise touch a production/shared database; it does not deploy to Render.
- The workflow/test changes create a new commit, so the new Actions run must finish successfully on the exact latest PR head before these additions can be marked CI-verified.
