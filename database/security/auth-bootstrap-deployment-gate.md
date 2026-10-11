# Authentication hardening deployment gate

**Status: staged only. Do not run this in production yet.**

The branch contains:
- `database/migrations/20261011_auth_bootstrap_hardening.sql`
- `backend/src/auth/auth-bootstrap.js`
- `backend/test/auth-bootstrap.test.js`
- updates to `backend/src/server.js` routing auth bootstrap through database functions.

The backend unit workflow is green, but this is not proof that the SQL migration is valid on the actual Supabase schema or that production login works.

## Mandatory preflight before applying SQL

1. Confirm the current production database connection role without printing or sharing the connection string or password.
2. Confirm the proposed application login role is a distinct role named `dadban_runtime`, has `LOGIN`, and has none of `SUPERUSER`, `BYPASSRLS`, table ownership, or membership in a privileged role. Do not use `postgres` as the app's runtime role.
3. Create/verify the separate non-login `dadban_auth_owner` role with `NOSUPERUSER NOBYPASSRLS`. The migration expects the database administrator to be able to create roles and transfer function ownership.
4. Inventory every SQL statement used by the backend and prepare the complete least-privilege grants for the runtime role. This migration only removes direct access to `auth_credentials` and `auth_sessions`; do not assume it completes the entire table-grant or RLS rollout.
5. Apply the migration only to a disposable copy/local database first. Verify function ownership, fixed search paths, EXECUTE grants, RLS policies, and direct-access denial before any production rollout.
6. Switch the Render database connection to the dedicated runtime role only after the full grant inventory and rollback plan are reviewed. Keep the old connection available only as a controlled rollback secret, not as the application's normal runtime.
7. Test registration, login, /api/auth/me, client/case/hearing CRUD, dashboard, logout, CSRF, expired/revoked sessions, and cross-office isolation on staging before production.

## Why no production switch is included

The production runtime role and Render connection configuration have not been confirmed in this work session. A code change alone cannot change which database role Render uses. Applying this migration without first provisioning the correct roles and grants can interrupt authentication or leave the current privileged connection in place.

## Rollback

Do not roll back by restoring a superuser runtime connection as the long-term solution. If staging fails, restore the prior application revision and revert the staging database migration from a snapshot/backup, then diagnose. Do not run destructive reverse SQL against production without a verified backup and a reviewed migration-specific rollback.
