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


## Exact-SHA result and fail-closed schema-object audit — 2026-10-14

- Run #111 completed successfully: [GitHub Actions #111](https://github.com/fzhtftp-commits/Dadban/actions/runs/38596118867). Its `head_sha` is exactly `d9a82650501e2cbcde0afbf1197dfefeb0d4caf9`, matching PR #4's head at the time of verification. All job steps passed, including npm tests, syntax checks, metadata isolation, full-baseline migration/rollback rehearsal, and two-office HTTP isolation.
- A further review found that migration 004 used `IF NOT EXISTS` for its table and indexes. That can silently accept an existing same-named object without validating its definition. Removed `IF NOT EXISTS` from the `case_documents` table and its three indexes so an unexpected pre-existing object fails rather than being treated as valid. This intentionally makes the migration non-idempotent: inspect and reconcile any pre-existing/partially applied objects before rerunning.
- Extended unit checks to guard this fail-closed source behavior. Extended the full-baseline SQL rehearsal to verify the actual definitions of all three office-scoped foreign keys and both named check constraints, not merely their names; index checks already assert the expected columns/order and partial predicates.
- The current migration/test changes created a new head after run #111. The new run must complete successfully on the exact current head before these latest changes are called CI-verified.
- PR #4 remains open, Draft, and unmerged. No changes were made to `main`, no operational database was accessed, and no Render deployment was performed.


### Final CI confirmation for fail-closed migration changes

- Run #114 failed in the new SQL catalog assertion because the assertion expected a particular textual formatting of PostgreSQL's CHECK expression; it was a test-matcher issue, not a migration-application failure. Run #115 exposed the same strict matcher on its own head.
- Relaxed that assertion to check the stable metadata_only expression token while still requiring storage_key IS NULL; retained explicit exact-definition checks for the three office-scoped foreign keys and the idempotency constraint.
- Run #116 completed successfully on exact head 90b6f418e5acbab4313169598e14389d54cc8694: https://github.com/fzhtftp-commits/Dadban/actions/runs/38596944490. All steps passed, including the full-baseline migration upgrade/rollback test.
- The migration now deliberately fails on pre-existing case_documents table or named document indexes instead of silently accepting them via IF NOT EXISTS. This protects against falsely treating a same-named but incompatible object as a valid migration result. Inspect/reconcile partial prior attempts before retrying; do not expect a safe blind rerun.
- This documentation update creates a new head; verify the next Actions run against that exact head before considering CI current. PR remains Draft and unmerged; no main, operational database, or Render changes.


### Negative test for an incompatible same-named table — 2026-10-14

- Added `backend/tests/case-documents-negative-migration.sh`. After the full-baseline rehearsal has created the expected public schema in the disposable PostgreSQL service, the script creates a dedicated probe schema containing an intentionally incompatible `case_documents(id integer)` table.
- It runs the real migration 004 with that probe schema first in `search_path`, and treats a nonzero `psql` exit as the expected result. If migration 004 unexpectedly succeeds, the test fails the workflow. A shell trap drops only the probe schema; the test does not touch `main`, an operational database, or Render.
- The workflow runs this negative test after the successful full-baseline migration test and before the two-office HTTP integration test. It tests the table-conflict path directly; same-named index conflicts are prevented by the migration's ordinary `CREATE INDEX` statements too, but this dedicated test does not claim to exercise that separate path.
- This commit updates the branch head. Do not call this new negative test CI-verified until the newly triggered GitHub Actions run succeeds on the exact latest PR head SHA.


### Negative migration test — CI result

- The disposable PostgreSQL negative test completed successfully in GitHub Actions run #120: https://github.com/fzhtftp-commits/Dadban/actions/runs/38597768618.
- Exact tested head SHA: 787f35fcb7b1e926758fbd91ade558d2c4dab72e; this matched PR #4's head when verified. The run's backend-tests check completed with conclusion success; npm tests, migration upgrade/rollback, the new incompatible-table negative test, and two-office HTTP isolation all passed.
- The expected SQL failure is caught by the shell harness and reported as a passing negative test; it does not intentionally leave the workflow red. The test is limited to the disposable PostgreSQL service.
- This report update creates a new commit, so the latest Actions result must be checked against the new exact PR head before saying the branch's final CI is current.

### Negative test for an incompatible same-named index — 2026-10-14

- Added `backend/tests/case-documents-negative-index-migration.sh` as a complement to the existing incompatible-table test.
- The script creates a dedicated disposable schema and `case_documents` fixture, then creates `case_documents_office_created_idx` with the deliberately wrong indexed column (`title`). It extracts the exact one-line `CREATE INDEX case_documents_office_created_idx` statement from migration 004 and executes it with the probe schema first in `search_path`.
- PostgreSQL must reject the statement because that index name already exists in the probe schema. The harness catches the expected nonzero exit and reports PASS; if PostgreSQL unexpectedly accepts it, the test exits nonzero. A cleanup trap drops only the probe schema and removes the temporary SQL file.
- **Coverage boundary:** this is a focused test of the actual index-creation statement, not a claim that the full migration runs from start to finish against an already-created compatible table. The separate negative-table test exercises the full migration's table-conflict path. Both use only the GitHub Actions disposable PostgreSQL service.
- The workflow now runs both negative tests before HTTP integration tests. Do not mark the new index test CI-verified until the latest Actions run completes successfully with a `head_sha` exactly matching PR #4's current head. PR #4 must remain Draft and unmerged; no `main`, operational database, or Render changes are in scope.

### Forced post-DDL failure and migration-runner transaction behavior — 2026-10-14

- Added `backend/tests/case-documents-forced-rollback.sh` and wired it into the branch-only workflow after the fresh full-baseline upgrade rehearsal.
- The test creates a dedicated disposable schema, starts an explicit PostgreSQL transaction, sets that schema first in `search_path`, executes the unmodified migration 004 SQL, and then appends a deliberate uncaught division-by-zero error after the table and all three indexes have been created. `psql` runs with `ON_ERROR_STOP=1`; the expected nonzero exit is captured by the harness rather than left as an unhandled CI failure.
- After the failed `psql` process closes its connection, the test queries PostgreSQL catalogs and requires that the table, all three named indexes, and table constraints are absent from the probe schema. A remaining object fails the test. A cleanup trap drops only the dedicated probe schema and temporary file.
- **Runner review:** `backend/package.json` defines only `start`, `dev`, and `test`; the repository has no general-purpose production migration-runner command/configuration identified in this review. The existing CI rehearsal invokes the migration inside explicit `BEGIN`/`COMMIT`, which proves PostgreSQL transactional DDL rollback when the caller provides that transaction, but does not establish what an external/manual deployment process does. Until the actual runner is named and its transaction behavior verified, any future application of migration 004 must use an explicit transaction and a disposable rehearsal first; do not assume a plain `psql -f` invocation is automatically atomic.
- This is disposable-test evidence only. It does not apply migration 004 to a shared or operational database, and does not deploy to Render. Keep PR #4 Draft and unmerged pending the exact-SHA CI result and human review.

### Out-of-transaction partial-apply demonstration and recovery boundary — 2026-10-14

- Added `backend/tests/case-documents-out-of-transaction-partial-apply.sh` and wired it into the branch-only workflow after the full-baseline migration rehearsal.
- In the disposable PostgreSQL service, the script creates a dedicated probe schema and a deliberately conflicting index name on a separate fixture table. It then runs the unmodified migration 004 with the probe schema first in `search_path` and **without** `BEGIN`/`COMMIT`. The migration is expected to create `case_documents`, then stop when its first index name collides. The harness catches the expected nonzero exit and verifies that the new table remains while the three migration indexes were not created on it. This demonstrates a real partial-apply state when statements are not wrapped in a transaction.
- The trap removes only the dedicated disposable schema after assertions. That is test-fixture cleanup, **not** a production recovery recipe; the script must never be pointed at a shared or operational database.
- **Recovery implication:** if a non-transactional execution fails after `CREATE TABLE`, the table and any earlier successful DDL may remain; if failure occurs at a later index, the table and earlier indexes may remain. Constraint declarations in the single `CREATE TABLE` statement are atomic with that statement, but later `CREATE INDEX` statements are separate commands. Exact remnants depend on the failing statement and what pre-existed. A blind retry can fail on the table or objects already created, and `IF NOT EXISTS` would not validate their definitions.
- **Safe response to a real failure:** stop the rollout/feature use; preserve command output and logs; identify the exact target and failure statement; inspect `pg_class`, `pg_indexes`, `pg_constraint`, and the table definition; compare every existing object to migration 004; and choose a reviewed forward repair or a data-preserving restore/recovery plan. Do not drop `case_documents` automatically if it may contain real metadata. Any destructive cleanup requires explicit environment confirmation, backup/recovery verification, and human approval.
- **Runner status remains unknown:** repository inspection found no general-purpose migration runner command/configuration in `backend/package.json` or the reviewed branch workflow. CI proves both (a) rollback with an explicit transaction and (b) partial objects without a transaction in the disposable service. It does not establish how an external deployment operator or Render process invokes SQL. That must be verified before any shared-environment migration.
- CI verification for this new test is pending until the latest Actions run completes and its `head_sha` exactly matches the current PR head. PR #4 remains Draft/unmerged; no `main`, operational database, or Render changes are in scope.

### Catalog inspection and go/no-go gates for recovery — 2026-10-14

The following catalog checks are **read-only examples** for an operator to adapt only after explicitly identifying the intended database and schema. They are not an automated production action and must not be pasted into a session until `current_database()`, server/host, and schema ownership are confirmed.

```sql
-- Confirm the session target first; stop if any value is unexpected.
SELECT current_database() AS database_name,
       current_user AS database_role,
       inet_server_addr() AS server_address,
       inet_server_port() AS server_port,
       current_schema() AS current_schema;

-- Inventory the table and its columns, types, nullability, and defaults.
SELECT n.nspname AS schema_name, c.relname AS object_name,
       c.relkind, a.attnum, a.attname,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS column_default
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = '<confirmed_schema>'
  AND c.relname = 'case_documents'
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;

-- List all constraints on the table with their full definitions and validation state.
SELECT con.conname, con.contype, con.convalidated,
       pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '<confirmed_schema>'
  AND c.relname = 'case_documents'
ORDER BY con.conname;

-- List all indexes on the table, including validity/readiness and full definitions.
SELECT i.indexrelid::regclass AS index_name,
       i.indisunique, i.indisvalid, i.indisready,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
JOIN pg_class t ON t.oid = i.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = '<confirmed_schema>'
  AND t.relname = 'case_documents'
ORDER BY i.indexrelid::regclass::text;

-- Check the expected names throughout the confirmed schema, including indexes
-- that might belong to a different table and therefore evade table-only checks.
SELECT c.relname AS object_name, c.relkind,
       pg_get_userbyid(c.relowner) AS owner_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = '<confirmed_schema>'
  AND c.relname IN (
    'case_documents',
    'case_documents_idempotency_unique_idx',
    'case_documents_office_case_created_idx',
    'case_documents_office_created_idx'
  )
ORDER BY c.relname;
```

Replace `<confirmed_schema>` with a schema identifier only after confirming the target. Do not treat a name match as proof of compatibility: compare column order/types/defaults, primary key, each foreign-key target and column order, each CHECK expression, and each index's columns/order, uniqueness, predicate, validity, and owning table against migration 004 and the approved baseline.

**GO only if all gates are satisfied:** exact target/environment confirmed; prerequisites and migration order verified; no unexpected same-named or partial objects; a backup has been restored successfully to a separate disposable database; a non-production rehearsal has passed; an explicit transaction strategy and the actual runner's behavior have been confirmed; and a human reviewer has approved the change window and recovery plan.

**STOP / do not retry** if the target is ambiguous, any expected prerequisite is missing, an object name exists with a mismatched definition, the table/index inventory suggests partial application, constraints or indexes are invalid/not ready, the backup/restore drill is unverified, or runner transaction semantics remain unknown. Preserve logs and catalog output, disable the feature/rollout, and request a reviewed repair plan. Never automatically drop the table or indexes in a shared environment; an object may contain real metadata or be shared by another dependency.

### Isolated recovery-catalog detection test — 2026-10-14

- Added `backend/tests/case-documents-catalog-recovery-audit.sh` and wired it into the branch-only GitHub Actions workflow. The script uses only the workflow's disposable PostgreSQL service and a dedicated probe schema removed by a cleanup trap.
- The fixture intentionally creates three incompatible objects: a same-named `case_documents` table missing the expected UUID `case_id` column, a same-named `case_documents_storage_metadata_consistency` constraint with the wrong expression, and a same-named `case_documents_office_created_idx` index on `title` rather than the expected office/timestamp columns.
- Assertions inspect `pg_class`, `pg_namespace`, `pg_attribute`, `pg_constraint` plus `pg_get_constraintdef`, and `pg_index` plus `pg_get_indexdef`/validity/readiness. The test passes only when catalog inspection detects each deliberate mismatch; matching names alone are not accepted as compatibility.
- **Coverage boundary:** this is a regression test for catalog inspection's ability to identify representative table/constraint/index mismatches. It does not implement an automated repair, validate every migration object or every possible type/default/FK/predicate mismatch, test invalid indexes created through concurrent index builds, or authorize production recovery. The human operator must compare complete catalog definitions to the approved migration and stop on ambiguity.
- CI must be reported as verified only after the workflow finishes on the exact current PR #4 head SHA. PR #4 remains Draft and unmerged; no changes to `main`, operational data, or Render are permitted.

### Comprehensive migration-004 catalog comparison — 2026-10-14

- Expanded `backend/tests/case-documents-catalog-recovery-audit.sh` beyond name-based spot checks. It first creates a clean dedicated schema in the disposable PostgreSQL CI database and executes the actual `backend/migrations/004_case_documents_metadata.sql` there, resolving prerequisite `offices`, `cases`, and `users` relations from the disposable baseline schema.
- Catalog assertions compare all 20 expected columns by ordinal position, type, and nullability; verify the inventory of column defaults and representative exact default expressions; check the primary key on `id`; check all four foreign keys including ordered composite office-scoped source columns and target columns/tables; and inspect all four CHECK constraints for their intended conditions and validation state.
- Index assertions inspect the actual owning table, uniqueness, ordered key columns, DESC sort keys, partial-index predicates, `indisvalid`, and `indisready` for the primary-key index and all three migration-created indexes. This is a definition-based comparison, not a name-only check.
- A separate incompatible fixture includes a same-named table missing required columns, a same-named CHECK with a wrong expression, a same-named FK with a wrong source/target definition, and a same-named index on the wrong column. The test verifies these catalog definitions are distinguishable from the approved migration shape.
- The script's cleanup trap removes only its two dedicated probe schemas. It runs only in the GitHub Actions disposable PostgreSQL service and never connects to an operational database.
- **Coverage limits:** this is a focused regression comparison against migration 004 and representative wrong-object fixtures, not a generic schema-diff engine for arbitrary PostgreSQL objects. It does not test every possible default-expression equivalence, generated/identity columns, triggers, privileges, extension versions, concurrent-index interruption states, or real backup restoration. Review the full catalog output and migration manually before any shared-environment operation.
- Do not call this expanded test verified until the latest GitHub Actions run completes successfully with `head_sha` equal to PR #4's current head. PR #4 must remain Draft/unmerged; `main`, operational data, and Render remain out of scope.
