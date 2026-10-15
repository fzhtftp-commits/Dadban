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


## Shared PostgreSQL rate limiting (opt-in)

The default `RATE_LIMIT_MODE=memory` preserves the existing single-process behavior. To opt into shared counters **only after rollout approval**, configure `RATE_LIMIT_MODE=postgres` and a stable, high-entropy `RATE_LIMIT_HMAC_KEY` of at least 32 bytes identically on every backend instance. The service intentionally fails startup if PostgreSQL mode is selected without `DATABASE_URL` or a sufficiently long key; it never falls back to the in-process map in PostgreSQL mode.

The key must be stored only in the deployment secret manager/environment, never committed, logged, generated at startup, or stored in PostgreSQL. The counter table stores only an HMAC-SHA-256 digest and counter/window metadata. The application does not trust forwarded client-IP headers because `trust proxy` remains disabled.

### Manual database rollout

There is no automatic migration runner. Before enabling PostgreSQL mode, review the target database and runtime role, take the normal backup/rollback precautions, then apply the new additive migration explicitly with the approved database credentials:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f backend/migrations/005_shared_rate_limits.sql
```

Run it from the repository root; use the same migration file reviewed in the PR. Confirm the table, constraints and expiry index exist, then grant only the required `SELECT`, `INSERT`, `UPDATE`, and `DELETE` privileges to the verified backend role (or establish an equivalent least-privilege owner arrangement). Do not guess the runtime role or assume RLS behavior from a local superuser test. The migration intentionally does not grant privileges to `PUBLIC` or guess a deployment role.

After the key and grants are verified on every instance, set `RATE_LIMIT_MODE=postgres` and deploy using the normal reviewed process. A counter DB error returns a generic HTTP 503 rather than a misleading 429; shared mode never silently falls back to per-process counters. Existing limits remain registration 5, login 10, and document creation 20 requests per 15-minute window. Do not change production settings as part of this PR.
