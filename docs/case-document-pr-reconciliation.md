# Case-document PR reconciliation audit

**Status:** Audit-only draft; no application or migration changes are made by this report.  
**Audit date:** 2026-10-15  
**Scope:** Dadban PRs #4 and #5 only. Keep both PRs open and Draft until a single implementation is reviewed.  
**Safety:** No changes to `main`, Render, production credentials, or the operational database. The audit branch starts from PR #3 head `12726d7c767c3eee368dbbf769067122285e500d`.

## Exact GitHub state checked

| Item | Head SHA | Latest checked CI | Result |
|---|---|---|---|
| PR #4 — `feature/case-documents-metadata` | `33662c6db84f437b6708a99c4e029674557b3d09` | [Push run #207](https://github.com/fzhtftp-commits/Dadban/actions/runs/38632380585) | Success |
| PR #5 — `feature/case-documents` | `b9cd61b4ec81cd6477e0de0d80cbf2e132881d4e` | [PR run #98](https://github.com/fzhtftp-commits/Dadban/actions/runs/38557734983) | Success |

Both runs were checked against the exact PR head SHA. PR #4's workflow is push-triggered on its feature branch and its run passed; PR #5's syntax and disposable-PostgreSQL integration jobs both passed. Green CI proves the checked suites passed, but does not make the two implementations interchangeable or authorize production migration.

## Confirmed overlap and differences

- Both PRs add a `case_documents` table, backend routes, `documents.html` / `documents.js`, and navigation links. Both modify `backend/src/server.js`, `actions.html`, `calendar.html`, `cases.html`, `clients.html`, and `index.html`. Treat them as competing implementations of the same feature, not as two independent features to merge unchanged.
- The migration locations differ: PR #4 uses `backend/migrations/004_case_documents_metadata.sql`; PR #5 uses `database/migrations/20261014_case_documents_metadata.sql`. The repository needs one canonical migration location and one authoritative migration sequence.
- The schemas are not equivalent. PR #4 includes filename/MIME/size metadata, idempotency key plus request fingerprint, same-office foreign keys for creator/updater, and a broader storage-status model. PR #5 adds a confidentiality field, title-length validation, a timestamp trigger, and different document-type values and delete/nullability semantics.
- **Storage safety requires a deliberate decision.** PR #5 constrains `storage_status` to `metadata_only` in the database. PR #4 permits `pending_storage`, `stored`, and `quarantined` as well as `metadata_only`; its consistency check permits a non-null `storage_key` for non-metadata-only states. Until private durable storage is separately approved and implemented, the reconciled migration/API should enforce metadata-only status and reject storage keys.
- PR #4 has a broader disposable-PostgreSQL migration rehearsal: baseline upgrade, forced rollback, partial-apply demonstration, incompatible-table/index checks, catalog audit, and two-office HTTP isolation. PR #5 has syntax checks and hearing/case-action integration coverage plus a document UI contract test. Preserve and combine relevant coverage rather than discarding either suite.
- PR #4 introduces `backend/src/document-transaction.js`; PR #5 does not. Its acquire/release/rollback behavior must be reviewed and tested in the unified implementation, not copied blindly.

## Recommended reconciliation sequence

1. Keep PRs #4 and #5 open, Draft, and unmerged; do not close either automatically.
2. Build one candidate from PR #3's head, with one migration, one API route implementation, and one documents UI.
3. Agree the canonical document-type enum, required/nullable creator fields, confidentiality semantics, title/description limits, soft-delete behavior, idempotency contract, and metadata-only storage invariant before coding.
4. Port the strongest relevant tests from both branches. Run the unified suite only against disposable PostgreSQL, including migration upgrade/rollback, cross-office access denial, CSRF, audit behavior, and negative storage-state/key cases.
5. Recheck the exact candidate SHA, PR head SHA, and CI results before asking for review. Do not apply migrations to the operational database or deploy as part of reconciliation.

## Scope boundary

This branch records findings and a safe plan only. It does not change either existing feature branch, alter any PR base, merge a PR, or modify `main` or any live database.
