# Migration 004 catalog audit report

Date: 2026-10-14
Scope: `backend/migrations/004_case_documents_metadata.sql` on `feature/case-documents-metadata`

## Current PR and CI evidence

- PR #4 is open, Draft, and unmerged; base branch is `feature/case-actions`.
- Catalog test commit: `5eb73c00416870fb42dd9bfc0e3e0a6693ccb3de`.
- GitHub Actions run [38624103780](https://github.com/fzhtftp-commits/Dadban/actions/runs/38624103780) completed successfully on that exact SHA. The `backend-tests` job passed.
- This run includes the expanded CHECK behavior matrix and exact FK/CHECK/index inventory assertions described below.
- No migration SQL, `main`, production database, or Render service was changed.

## Catalog coverage

The test applies the actual migration into a schema isolated inside the GitHub Actions disposable PostgreSQL database; parent tables come from that disposable baseline. It does not point at a shared or production database.

- **Columns (20):** exact inventory, ordinal position, name, formatted type, nullability, and absence of unexpected identity/generated/inherited attributes.
- **Defaults (5):** exact normalized default expressions for `id`, `document_type`, `storage_status`, `created_at`, and `updated_at`; rejects any extra default.
- **Primary key:** must be validated and key only `id`.
- **Foreign keys (4):** exact constraint-name inventory, composite source and target column order for office-scoped case/creator/updater relations, target tables/columns, validation, and rejection of non-default action/match/deferrability settings. The direct office FK is included in the exact inventory and target checks.
- **CHECK constraints (5):** exact constraint-name inventory and validation; two cross-field invariants are compared using normalized full catalog expressions. The actual catalog expressions for document type, storage status, and size limit are evaluated against allowed-value and boundary matrices: all expected enum members must pass, unexpected values must fail, and size limits test NULL, -1, 0, 25 MiB, and 25 MiB + 1. Cross-field probes check metadata-only/storage-key combinations and all idempotency/fingerprint pairing cases.
- **Indexes (4 including PK):** exact index-name inventory; key order/count, uniqueness, partial predicates, validity/readiness, and expected index definitions are checked for all three migration indexes and the PK index.
- **Negative fixture:** same-named but incompatible table, CHECK, FK, and index definitions are deliberately created and inspected so object names alone cannot make the fixture appear compatible.

## Interpretation and remaining limitation

The checks combine catalog metadata comparisons with executable behavior probes. The behavior probes detect meaningful changes in the three inline CHECK rules, but they are not a formal proof of logical equivalence for every possible SQL expression. If a future review requires strict normalized-text equality for those three inline expressions as well, add it only after verifying PostgreSQL's actual deparsed form in the disposable CI environment. Do not describe this automated audit as a production migration test or legal/security certification.

## Safety boundaries

- Migration execution is limited to the disposable PostgreSQL service in GitHub Actions.
- No production database, `main`, Render service, or deployed migration was changed.
- PR #4 must remain Draft and unmerged.
- For every subsequent change, report CI as green only when the successful workflow's `head_sha` exactly matches the current PR head.
