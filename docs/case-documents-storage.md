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
