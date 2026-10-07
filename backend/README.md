# Dadban Backend

Backend foundation for the Dadban legal-office management system.

## Stack
- Node.js 20+
- Express
- PostgreSQL
- Helmet
- CORS
- Zod (reserved for request validation)

## Current security posture

Business endpoints are intentionally locked behind `requireAuth`. No client data is exposed until the final authentication/session architecture is implemented.

The backend must receive database credentials only through environment variables. Never commit `DATABASE_URL`, tokens, passwords, or private keys.

## Local setup

1. Install Node.js 20+.
2. Run `npm install`.
3. Create a local `.env` from `.env.example` and provide `DATABASE_URL`.
4. Execute `database/schema.sql` against PostgreSQL.
5. Run `npm start`.
6. Check `GET /health`.

## Next backend step

Implement the authenticated session layer first, then add the real CRUD handlers for `clients`. The handlers must derive `office_id` and `user_id` from the authenticated server-side context rather than accepting them from the browser.
