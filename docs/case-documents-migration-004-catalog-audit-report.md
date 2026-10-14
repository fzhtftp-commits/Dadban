# Migration 004 catalog audit report

Date: 2026-10-14
Scope: `backend/migrations/004_case_documents_metadata.sql` on `feature/case-documents-metadata`
Status: catalog assertion refinement in progress; the first push-triggered run of the expanded assertions failed, and the follow-up run must verify the normalization fix.

## Current PR and CI evidence

- PR #4 is open, Draft, and unmerged; base branch is `feature/case-actions`.
- Before this update, PR head was `caa5c9c916595b69d3bcc2e8cced7dd08d1cdd9d`.
- Push-triggered workflow run `38615194007` ran against `d293366cb37d98c00d9798402181db2954ecf42f` and failed in step 13 (`Verify recovery catalog audit detects incompatible table, constraint, and index in disposable PostgreSQL`). The exact assertion failure was `CHECK expression differs from the full expected invariant`; preceding npm, syntax, migration-upgrade, rollback, and negative-migration steps passed.
- The follow-up patch normalizes both `::character varying` and `::text` presentation casts before comparing the two full CHECK expressions. This is a test-harness normalization correction, not a migration/schema change.
- This report is intentionally not marked CI-passing. The new head SHA must be checked independently and the run must complete against that exact SHA.

## Catalog contract checked

The disposable PostgreSQL 16 test applies the actual migration into an isolated schema (parent tables are resolved from the disposable baseline schema) and compares catalog metadata, rather than treating matching names as proof of compatibility.

- All 20 columns: ordinal position, name, formatted type, nullability, and the inventory of column defaults; UUID and documented string defaults are checked.
- Primary key: the key must be `id`.
- Foreign keys: four expected relations including the office FK and three composite office-scoped FKs; source and referenced key column order, referenced relation, validation state, match mode, update/delete actions, and deferrability are inspected.
- CHECK constraints: expected inventory and validation state, including document type, size cap, storage state, metadata-only storage consistency, and idempotency/fingerprint pairing. The two cross-field invariants are compared as normalized expressions, not just by object name.
- Indexes: expected inventory including the PK index and three migration indexes; uniqueness, ordered key definitions, partial predicates, validity/readiness, and key counts are checked.
- Negative fixture: a deliberately incompatible same-named table, CHECK, FK, and index are inspected to ensure the test distinguishes names from definitions.

## Limits and safety boundaries

- This is automated schema-catalog verification, not a production migration or restore test.
- The migration is run only in the disposable PostgreSQL service configured by GitHub Actions.
- No production database, `main`, Render service, or deployed migration was changed.
- PR #4 must remain Draft and unmerged.
- Do not report green CI until the final workflow run's `head_sha` exactly equals the current PR head SHA and the run concludes successfully.
