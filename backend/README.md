# Dadban Backend

Backend foundation for the Dadban legal-office management system.

## Stack
- Node.js 20+
- Express
- PostgreSQL
- Helmet
- CORS
- Zod request validation

## Security notes
- Business endpoints require a valid server-side session; derive `office_id` and `user_id` from authenticated context, never from client input.
- Keep database credentials in environment variables. Never commit `DATABASE_URL`, tokens, passwords, or private keys.
- JSON request bodies are limited to 100 KiB. This module stores document metadata only; it does not upload file bytes.
- Login is limited to 10 requests per IP per 15 minutes and document creation to 24 requests per IP per 15 minutes. The current limiter is in-memory and per process; for multi-instance production deployment, use a shared rate-limit store at the trusted edge or a shared backend.
- Document create requests may send an `Idempotency-Key` header (8–128 characters from letters, digits, dot, underscore, colon, or hyphen). A retry with the same key and same normalized payload returns the existing record without a second audit event; reuse with a different payload returns HTTP 409. Clients should generate a new key for each intended new document.

## Local setup
1. Install Node.js 20+.
2. Run `npm install`.
3. Create a local `.env` from `.env.example` and provide `DATABASE_URL`.
4. For a disposable local database, apply the baseline schema at `database/schema.sql` as needed.
5. Run `npm start` and check `GET /health`.
6. Run automated tests with `npm test`.

## Case-document metadata migration (manual; no production deployment performed)
The migration `migrations/004_case_documents_metadata.sql` creates the metadata-only table, office-scoped foreign keys and indexes, and the idempotency-key index.

Before applying it to any shared environment:
1. Confirm the target database and take a verified backup.
2. Review the exact migration file from the intended branch/commit.
3. Apply it first to a disposable database and run the migration/isolation integration tests.
4. Apply it manually during an approved maintenance window using the environment's configured PostgreSQL client, for example:
   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/004_case_documents_metadata.sql
   ```
5. Verify the `case_documents` constraints and indexes in `pg_constraint` and `pg_indexes`, then run the API smoke tests.

This migration uses `CREATE TABLE/INDEX IF NOT EXISTS`; that makes repeated execution safe for objects it has already created, but it does **not** upgrade an older pre-existing `case_documents` table to a newer shape. Inspect the existing schema before rerunning or adapting it. Do not run it against production until separately reviewed and explicitly approved.

## Session and cookie behavior
Sessions expire server-side after 8 hours and are rejected when `expires_at <= now()`, revoked, or associated with an inactive/deleted user. The session cookie is HttpOnly; cookies use Secure in production and SameSite=None in production (Lax outside production). Browser write requests also require the configured Origin and CSRF token.

## Scope
This branch adds case-document metadata management only. Actual file upload and object storage remain disabled.
