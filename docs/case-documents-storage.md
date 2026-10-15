# Case documents: metadata-only phase

## Scope
This feature manages metadata for documents attached to a case. It does not accept, stream, store, serve, or delete file bytes. Filename, MIME type, and size are descriptive user-supplied metadata, not proof that a file exists or is safe.

## Security controls
- Authenticated reads/writes are filtered by current office.
- Creation verifies the active case belongs to the same office.
- Composite foreign keys bind case and actor to the same office.
- Writes require trusted-origin and CSRF checks, parameterized SQL, transactions, and audit events.
- Strict payload validation, 25 MiB descriptive size cap, and soft deletion.
- No public URLs, storage credentials, upload endpoints, or download endpoints are introduced.

## Before real uploads can be enabled
1. Select private object storage after data-residency, legal/privacy, and provider-contract review appropriate for sensitive legal files. Do not store file bytes in the repository, GitHub Pages, or an ephemeral Render filesystem.
2. Verify current Render plan filesystem persistence, request/body limits, timeouts, bandwidth/egress, backups, restore, and region availability.
3. Define private bucket policy, encryption/key rotation, least-privilege credentials, short-lived signed URLs or authenticated streaming, malware scanning/quarantine, MIME sniffing and file-signature validation, archive-bomb limits, checksums, retention/legal hold, and audit events.
4. Decide allowed formats, size limits, incident response, backup/restore tests, and privacy/legal requirements.
5. Validate in isolated staging and obtain explicit product-owner approval before adding upload routes or storage credentials.

## Migration
004_case_documents_metadata.sql is separate and must be reviewed and manually applied only to a disposable/development database. This PR does not alter production data or Render.


## Confidentiality access policy (PR #9)
The API, not the UI, enforces this policy:
- **Owner / Admin:** read, create, edit, and soft-delete all levels.
- **Lawyer:** read, create, and edit all levels; cannot delete or change a document's confidentiality level.
- **Assistant:** read, create, and edit `normal` and `confidential`; no access to `restricted`; cannot delete or change confidentiality.
- **Viewer:** read `normal` only; cannot create, edit, or delete.
- List queries filter unauthorized levels in SQL. Detail/update requests for inaccessible records return a non-disclosing not-found response. All access remains office-scoped.
- Owner/Admin classification changes are recorded in update audit metadata with both the previous and new level.
- Soft deletion hides document metadata from the list/detail APIs but retains the database row. Deleting a parent case also hides its linked documents without changing the document row's own `deleted_at`; this preserves the distinction between document deletion and case deletion.
- **Retention is not yet defined:** this metadata-only phase has no automatic hard-delete/purge job, archival/export process, or legal-hold workflow for soft-deleted document metadata. Therefore, soft-deleted rows may remain indefinitely. Do not add an automatic purge until the product/legal owner approves a retention period, its start event, legal-hold exceptions, recovery requirements, and how audit history must be preserved. Audit-log retention is a separate unresolved decision documented in `docs/security/audit-logs-retention-review.md`.
- No document export/report endpoint or file download route is implemented in this phase. If exports are added later, they must explicitly exclude soft-deleted documents and documents whose parent case is soft-deleted, apply the same office/confidentiality authorization, and be covered by regression tests.
- No schema change is needed; existing disposable PostgreSQL migration, catalog, office-isolation and forced-rollback checks remain required.
