# Migration 004 catalog audit report

Date: 2026-10-14
Scope: `backend/migrations/004_case_documents_metadata.sql` on `feature/case-documents-metadata`
Status: the current catalog audit and backend workflow passed on the exact PR head recorded below. This report distinguishes assertions already enforced from further tightening still needed.

## Current PR and CI evidence

- PR #4 is open, Draft, and unmerged; base branch is `feature/case-actions`.
- Verified PR head: `1b4fa5b8020349c0f192d6a40affe68ef178c779`.
- GitHub Actions run [38623425809](https://github.com/fzhtftp-commits/Dadban/actions/runs/38623425809) completed with conclusion `success` and `head_sha` exactly matching the PR head above.
- The `backend-tests` job passed, including Node tests, disposable PostgreSQL migration/rollback checks, the catalog recovery audit, incompatible-index checks, and two-office HTTP isolation.
- Earlier failures and their fixes remain in the workflow history; the latest exact-head result above is the current evidence, not a claim that every possible schema drift has been tested.
- No migration SQL or production schema was changed.

## Catalog contract checked

The disposable PostgreSQL 16 test applies the actual migration into an isolated schema (parent tables are resolved from the disposable baseline schema) and compares catalog metadata, rather than treating matching names as proof of compatibility.

- All 20 columns: ordinal position, name, formatted type, nullability, exact inventory and normalized full expressions of the five defaults (`id`, `document_type`, `storage_status`, `created_at`, `updated_at`), and absence of defaults on other columns.
- Column attributes: unexpected identity, generated, or inherited-column flags are rejected.
- Primary key: must be validated and use `id`.
- Foreign keys: four expected relations; the three composite office-scoped FKs are checked for ordered source/target columns and targets. The audit also rejects unexpected FK action/match/deferrability settings.
- CHECK constraints: expected count and validation state; the two cross-field invariants are compared as normalized expressions. The document-type, size-limit, and storage-status checks currently use expected object names plus expression-fragment assertions. Therefore this is not yet a full exact-expression comparison for all five CHECKs.
- Indexes: expected inventory including the PK index and three migration indexes; uniqueness, ordered key definitions, partial predicates, validity/readiness, and key counts are checked.
- Negative fixture: a deliberately incompatible same-named table, CHECK, FK, and index are inspected to ensure the test distinguishes definitions from names.

## Next catalog-hardening step

Before treating this as exhaustive schema-drift protection, strengthen the assertions to compare the complete normalized expressions for all five CHECK constraints and exact expected FK/index inventories and definitions, including unexpected-object rejection. Run those tests only in the disposable PostgreSQL workflow and update this report only after the resulting run's `head_sha` exactly matches the PR head and succeeds.

## Limits and safety boundaries

- This is automated schema-catalog verification, not a production migration or restore test.
- The migration is run only in the disposable PostgreSQL service configured by GitHub Actions.
- No production database, `main`, Render service, or deployed migration was changed.
- PR #4 must remain Draft and unmerged.
- Do not report green CI until the final workflow run's `head_sha` exactly equals the current PR head SHA and the run concludes successfully.
