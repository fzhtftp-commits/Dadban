# Migration 004 catalog audit report

Date: 2026-10-14
Scope: `backend/migrations/004_case_documents_metadata.sql` on `feature/case-documents-metadata`
Status: automated catalog assertions added; CI result pending for the resulting branch head.

## Current PR and CI evidence

- PR #4 is open, Draft, and unmerged; base branch is `feature/case-actions`.
- Before this update, PR head was `caa5c9c916595b69d3bcc2e8cced7dd08d1cdd9d`.
- GitHub's available commit-status endpoint returned no statuses for that SHA. The connected workflow-run listing returned no PR-triggered runs for that SHA; this endpoint filters to PR-triggered runs and therefore does not prove the absence of a push-triggered run.
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
