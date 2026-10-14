# Unified case-document metadata implementation plan

**Status:** Design plan only; not an implementation approval.  
**Created:** 2026-10-15  
**Target base:** `feature/case-actions` at `12726d7c767c3eee368dbbf769067122285e500d` (PR #3 head when this branch was created).  
**Scope:** Reconcile the competing case-document implementations in PRs #4 and #5 into one implementation.  
**Safety boundary:** Do not modify `main`, PR #4, PR #5, Render configuration, secrets, or the operational database. All migration/API verification must use disposable PostgreSQL only.

## 1. GitHub state checked first

- PR #7 is open, Draft, and unmerged. Its head is `d807f8a798a9dbd410556f42aabaef2a0e97b386`, on `audit/document-pr-reconciliation-2026-10`.
- The GitHub API returned zero check runs and no workflow runs for that exact PR #7 head at the time checked. Therefore its CI is **not green; it is not yet reported by GitHub**.
- PR #4 remains open, Draft, and unmerged at `33662c6db84f437b6708a99c4e029674557b3d09`. Its checked Push run #207 passed: https://github.com/fzhtftp-commits/Dadban/actions/runs/38632380585
- PR #5 remains open, Draft, and unmerged at `b9cd61b4ec81cd6477e0de0d80cbf2e132881d4e`. Its checked PR run #98 passed: https://github.com/fzhtftp-commits/Dadban/actions/runs/38557734983
- These passing runs apply only to their own SHAs; they do not prove the two branches can be merged together.

## 2. What conflicts and must be reconciled

Both feature branches add a document list/form, API handlers, navigation links, and a `case_documents` table. They modify the same application server and UI surfaces, so they are alternative implementations rather than independent features.

| Concern | PR #4 (`feature/case-documents-metadata`) | PR #5 (`feature/case-documents`) | Unified decision |
|---|---|---|---|
| Migration path | `backend/migrations/004_case_documents_metadata.sql` | `database/migrations/20261014_case_documents_metadata.sql` | Keep one canonical path: `backend/migrations/004_case_documents_metadata.sql`, after confirming the base migration sequence on the candidate branch. |
| Storage | Allows `pending_storage`, `stored`, `quarantined`; has `storage_key` | DB check allows only `metadata_only` | Metadata-only in both DB and API; no `storage_key` column, no upload route, no binary payload acceptance, and no storage provider configuration. |
| Document types | `petition`, `contract`, `evidence`, `court_order`, `correspondence`, `identity`, `receipt`, `other` | `pleading`, `evidence`, `contract`, `correspondence`, `court_order`, `identity`, `other` | Adopt a documented union: `petition`, `pleading`, `contract`, `evidence`, `court_order`, `correspondence`, `identity`, `receipt`, `other`. Keep the exact same enum in SQL, Zod validation, UI options, and tests. |
| Confidentiality | Not present | `normal`, `confidential`, `restricted` | Keep the field and enum; default to `confidential`. UI visibility is not an authorization boundary. |
| Creator/updater | Required IDs and intended composite same-office foreign keys | Nullable single-column user FKs with `ON DELETE SET NULL` | Use authenticated user IDs; require creator/updater IDs and enforce office matching in composite foreign keys. Confirm required composite unique keys exist before creating the FKs. |
| Idempotency | Unique per office/creator and payload fingerprint | Not present | Preserve PR #4's `Idempotency-Key` plus normalized request fingerprint; same key/same payload is replay-safe, same key/different payload returns 409. |
| Updated timestamp | Explicit updates in API | `set_updated_at()` trigger | Use the repository's existing `set_updated_at()` function and one trigger, then test that update changes the timestamp. |
| Validation | File metadata and 3,000-character description | Title minimum length, description up to 5,000 chars | Choose one contract: trimmed title length 2–200, description up to 3,000 chars, reference number up to 120 chars, supported type enum and confidentiality enum. Mirror limits in SQL, API, UI and tests. |
| Tests | Extensive migration/rollback/catalog and two-office HTTP tests | UI contract and case/hearing tests | Preserve the strongest relevant checks from both branches; do not copy either branch wholesale. |

### Important schema prerequisite

The baseline `database/schema.sql` gives `users.id` a primary key but does not declare a composite unique constraint on `(id, office_id)`. A composite FK from `case_documents(created_by, office_id)` cannot be created unless PostgreSQL has a matching unique key on the referenced columns. Before the document FK, verify and, if absent, add a safely named unique index/constraint on `users(id, office_id)` in the candidate migration. Similarly verify `cases(id, office_id)`. Do not infer readiness from object names alone; inspect `pg_constraint`, `pg_index`, column definitions, and index validity in the disposable test database.

## 3. Target schema contract

The single migration should create `case_documents` with:

- UUID primary key; required `office_id`, `case_id`, `title`, `document_type`, `confidentiality`, `storage_status`, `created_by`, `updated_by`, and timestamps.
- Composite same-office FKs for `(case_id, office_id)`, `(created_by, office_id)`, and `(updated_by, office_id)`; deletion of referenced office/case/user must not silently orphan or reassign a document.
- A title check requiring `length(btrim(title)) BETWEEN 2 AND 200`, the agreed type/confidentiality enums, description/reference length checks, and soft-delete timestamp.
- `storage_status` with default `metadata_only` and a database CHECK that permits **only** `metadata_only`. Do not add a `storage_key` column. No state such as `stored`, `pending_storage`, or `quarantined` is valid in this release.
- Unique partial idempotency index on `(office_id, created_by, idempotency_key)`, only when a key is supplied, plus active-record list indexes by office/case/date.
- One `updated_at` trigger using the existing `set_updated_at()` function.
- No destructive `DROP`, no unsafe `CREATE ... IF NOT EXISTS` used as a substitute for schema validation, and no assumptions that a pre-existing same-named table has the correct shape.

All DDL should run in a transaction. A migration that detects an incompatible pre-existing object must fail clearly and leave no partial DDL. Keep the existing migration rehearsal, forced-failure rollback, incompatible table/index, and catalog-recovery tests.

## 4. API and authorization contract

All routes require the existing server-side session. Derive `office_id` and `user_id` exclusively from authenticated server context; never trust either value from the request body or query string.

- `GET /api/documents`: return only active documents belonging to the authenticated office; optionally filter by a case that is independently verified to belong to the same office.
- `POST /api/documents`: require trusted Origin and valid CSRF token, validate a strict Zod schema, confirm the case belongs to the current office, set office/creator/updater/status server-side, write the document and audit event transactionally, and support idempotent retries.
- `PATCH /api/documents/:id`: require Origin + CSRF, strict allow-listed fields, an active same-office document, and same-office case validation if `case_id` changes. Do not allow updates to `office_id`, `created_by`, `storage_status`, `storage_key`, or audit metadata.
- `DELETE /api/documents/:id`: require Origin + CSRF and soft-delete only a same-office active record; record the audit event in the same transaction.
- Cross-office document IDs and case IDs should produce a non-disclosing not-found response (404). Never return another office's record in errors, list results, audit metadata, or idempotency replay.
- Reject request fields such as `storage_key`, `storage_status`, `file`, `file_data`, `upload_url`, or binary/base64 content. Do not silently ignore attempts to request a storage state; strict schemas should return 400. Responses always identify the item as metadata-only and the UI must state that no file was uploaded.
- Keep bounded request size, role authorization, rate limiting, safe error logging, CSRF and trusted-Origin checks consistent with the existing backend. Avoid adding a new proxy trust setting as a side effect of this feature.

## 5. Required test matrix before implementation PR is reviewable

1. **Migration/catalog:** clean upgrade; expected columns, types, nullability, defaults, CHECKs, FKs, indexes and trigger compared to definitions, not names alone; incompatible same-named table/constraint/index fails safely.
2. **Rollback:** forced failure after DDL begins leaves no partial objects; transaction and pool client are cleaned up correctly.
3. **Storage invariant:** direct SQL attempts to insert/update any status other than `metadata_only` fail; schema contains no `storage_key`; API rejects storage-state/key/upload fields and binary payloads.
4. **Office isolation:** office A cannot list, read, update, soft-delete, or associate documents with office B's case/user; cover both HTTP behavior and direct composite-FK violations.
5. **CSRF/Origin:** missing/wrong CSRF and untrusted Origin fail writes; valid token/origin succeeds.
6. **Audit/atomicity:** create/update/delete each emit the expected office/user/entity audit event; an injected audit insert failure rolls back the document mutation.
7. **Validation/idempotency:** invalid title/type/confidentiality/date/lengths return 400; same key and same payload do not duplicate rows or audit; same key with different payload returns 409.
8. **UI contract:** one page and one navigation link set; create/edit/list/soft-delete flows; visible metadata-only/no-upload notice; no file picker or upload action.
9. **Regression:** run the relevant existing backend tests and the case-action/hearing tests inherited from the base branch.

All HTTP tests and migrations must point only to a disposable local/PostgreSQL service database. Tests must fail closed if `DATABASE_URL` points anywhere other than the dedicated localhost test DB. No test may use Render or production credentials.

## 6. Execution order

1. Recheck exact heads and latest CI for PRs #3–#7; do not duplicate existing reports or alter PR #4/#5.
2. On the independent implementation branch, inspect the current migration sequence and actual catalog requirements.
3. Implement the canonical migration and its database-level invariant first.
4. Implement one document router/service with transaction-safe audit behavior and strict API validation; integrate it into the existing server once, without duplicating middleware or routes.
5. Reconcile the single UI and navigation links.
6. Port/merge relevant tests from both competing branches and add negative storage-invariant tests.
7. Run syntax/unit/integration/migration tests against disposable PostgreSQL; inspect CI on the exact new SHA and verify it equals the branch and PR head.
8. Keep the resulting PR Draft and unmerged pending human review. Do not merge PR #4/#5 or apply a migration to any shared/operational database.

## 7. Explicit non-goals

This plan does not implement uploads, object storage, download URLs, antivirus scanning, OCR, or document-content indexing. Those require a separate threat model and explicit review. This plan also does not change the operational database or deployment settings.
