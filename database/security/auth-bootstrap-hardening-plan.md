# Authentication bootstrap hardening — implementation plan

Status: design checkpoint only. This document is not a migration and must not be executed as SQL.

## Why this checkpoint exists

The local security test proved that the current restricted test role can read rows from both `auth_sessions` and `auth_credentials` with no `app.current_office_id` context. Both tables currently have RLS disabled in the local test database. The current server also performs two bootstrap reads before tenant context is established:

- `findActiveSession(pool, tokenHash)` joins `auth_sessions` to `users`.
- `POST /api/auth/login` joins `users` to `auth_credentials` by email.

Simply enabling RLS or revoking table privileges now would break one or both flows.

## Required design

1. Provision a dedicated application runtime database role that is not a superuser, does not have `BYPASSRLS`, does not own tenant tables, and receives only the privileges the API needs. Do not keep using the production `postgres` role for the application.
2. Keep bootstrap operations narrow and explicit. The runtime role must not have direct SELECT access to password hashes. A reviewed, narrowly scoped database function may return the minimum login result for one normalized email and may locate one active session by a SHA-256 token hash.
3. Any `SECURITY DEFINER` function must have a trusted owner, a fixed safe `search_path`, fully qualified table names, no dynamic SQL, revoked default PUBLIC execute privileges, and explicit EXECUTE grants only to the runtime role. Do not use a superuser-owned function as a shortcut without a documented threat review.
4. Session INSERT must be narrowly mediated or allowed only through an equally reviewed path. Session UPDATE for `last_seen_at` and `revoked_at` must require the transaction-local office context and a matching session `office_id`.
5. Registration must remain atomic: office, user, credential, and session either all commit or all roll back. The user row's office context and any office creation permissions must be considered before enabling RLS on `users`.
6. Do not apply production changes until the exact Render/Supabase runtime connection role and the role/function ownership model have been confirmed.

## Acceptance tests

- With no office context, direct reads of `auth_sessions` and `auth_credentials` through the runtime role are denied or return no rows as designed.
- Session bootstrap finds only the session matching the supplied token hash, rejects expired/revoked sessions, and requires the session/user office IDs to match.
- Login can verify a valid scrypt hash without granting the runtime role direct table access to `auth_credentials`.
- Wrong password, unknown email, inactive user, and soft-deleted user all fail without issuing cookies or creating a session.
- Registration rolls back office, user, credential, and session together on any injected failure.
- A session from office B cannot be read, touched, or revoked under office A's context.
- Logout revokes the current session only and clears cookies.
- CSRF and trusted-origin tests remain green.
- All existing backend tests pass.
- Local test data is rolled back; production database and Render settings remain untouched.

## Current known prerequisites

- Local `dadban_test_runtime` is a non-login test role with `NOSUPERUSER` and `NOBYPASSRLS`.
- The application code currently uses direct table queries for bootstrap login/session lookups.
- The actual production runtime role has not been confirmed in this checkpoint; prior diagnostics indicated a connection role with `BYPASSRLS`, which must be corrected separately before RLS can be relied upon.
