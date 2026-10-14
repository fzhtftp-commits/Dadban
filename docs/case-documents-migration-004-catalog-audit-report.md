# Migration 004 catalog audit report

Date: 2026-10-14
Scope: `backend/migrations/004_case_documents_metadata.sql` on `feature/case-documents-metadata`
Status: expanded catalog assertions passed on the pre-default-tightening head; exact default-expression assertions added in a follow-up commit, and CI is pending for that latest head.

## Current PR and CI evidence

- PR #4 is open, Draft, and unmerged; base branch is `feature/case-actions`.
- Before this update, PR head was `caa5c9c916595b69d3bcc2e8cced7dd08d1cdd9d`.
- The initial expanded run `38615194007` on `d293366cb37d98c00d9798402181db2954ecf42f` failed because PostgreSQL presented a CHECK expression with a cast not removed by the test normalization.
- The normalization fix passed on commit `28c532ecb5151161274d750b619d7d52dc2c8ab5` in workflow run `38623151107` (success). The entire `backend-tests` job passed, including catalog recovery audit, negative-index migration, and two-office HTTP isolation.
- A further test-only tightening now compares all five expected column default expressions exactly after removing presentation-only casts/whitespace and rejects any unexpected default columns. This is on commit `b022ad23863aaf857cefb39e6803df0696bd63af`; CI for the latest head must be checked before calling the current branch green.
- No migration SQL or production schema was changed.

## Catalog contract checked

The disposable PostgreSQL 16 test applies the actual migration into an isolated schema (parent tables are resolved from the disposable baseline schema) and compares catalog metadata, rather than treating matching names as proof of compatibility.

- All 20 columns: ordinal position, name, formatted type, nullability, and the exact inventory and normalized full expressions of all five defaults (`id`, `document_type`, `storage_status`, `created_at`, `updated_at`), plus the absence of defaults on other columns.
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
