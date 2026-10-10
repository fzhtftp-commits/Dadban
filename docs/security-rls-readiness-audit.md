# Dadban RLS Readiness Audit (Pre-Migration)

Date: 2026-10-10
Branch: `security/rls-rollout-plan`

## Scope and safety

This is a code/configuration review only. No live database schema, role, grant, RLS policy, Render environment variable, or production deployment was changed during this review.

The local backend test suite reported 7 passing tests and 0 failures:
- active session lookup matches the user to the session office;
- malformed token hashes are rejected before querying;
- tenant transaction context is transaction-local;
- invalid office IDs are rejected before acquiring a connection;
- tenant query/context failures trigger rollback and release.

These tests are useful but do not establish end-to-end RLS readiness.

## Observed runtime database role

The read-only runtime-role diagnostic, run using the Render `DATABASE_URL`, reported:
- `current_user = postgres`
- `session_user = postgres`
- `rolsuper = false`
- `rolbypassrls = true`
- full SELECT/INSERT/UPDATE/DELETE privileges on all eight Dadban tables queried.

Therefore, the current runtime role can bypass RLS. Enabling policies alone will not provide database-enforced tenant isolation while this role remains in use.

## Code observations

1. Tenant-facing dashboard, client, and case reads include office predicates and generally use `withOfficeTransaction` or a transaction with `set_config('app.current_office_id', ..., true)`.
2. The helper correctly sets office context transaction-locally, commits/rolls back, and releases the pooled connection.
3. Authentication bootstrap occurs before a trusted office context is known:
   - `/api/auth/login` queries `users` and `auth_credentials` directly through the pool, then inserts an `auth_sessions` row.
   - `findActiveSession` queries `auth_sessions` joined to `users` directly through the pool.
   - `/api/auth/register` creates an office, user, credential, and session in a direct transaction.
4. Those authentication paths require an explicit least-privilege design before a non-BYPASSRLS runtime role can be adopted. Simply revoking broad grants or enabling RLS now may break login, registration, and session validation.
5. Schema comments explicitly defer RLS policies until the database role strategy is finalized.

## RLS readiness decision

**Not ready for production RLS rollout.** Do not merge/deploy an RLS migration or alter the production role based solely on this audit.

## Required work before rollout

1. Define separate privileges for normal tenant queries and pre-tenant authentication bootstrap.
2. Choose and review a safe bootstrap design (for example, tightly scoped database functions with a fixed safe `search_path` and explicit EXECUTE grants, or a separate restricted authentication connection/role). Do not expose a general-purpose bypass role to ordinary request handlers.
3. Inventory every database query and ensure tenant-facing access sets trusted office context within the same transaction and is constrained by both API predicates and RLS policies.
4. Write policies for every table, including `offices`, `users`, `auth_credentials`, `auth_sessions`, `clients`, `cases`, `hearings`, and `audit_logs`, with deliberate behavior for authentication and audit writes.
5. Add integration tests that connect as the proposed restricted runtime role and verify cross-office SELECT/INSERT/UPDATE/DELETE are denied, valid same-office operations work, and auth login/register/session bootstrap still function.
6. Test migrations and rollback in a disposable database first; verify current grants, policies, ownership, and connection-pool behavior before any production change.
7. Rotate the database password if it was ever exposed outside trusted configuration. Never paste connection strings, passwords, or tokens into chat or commit them to the repository.

## Current status

- Existing unit tests: 7 pass, 0 fail (reported by the developer).
- Runtime role diagnostic: complete; RLS bypass is enabled for the current role.
- Full route/query inventory: incomplete.
- Restricted runtime role: not configured or validated.
- Authentication bootstrap design: pending.
- RLS policies and integration tests: pending.
- Production rollout: blocked; no production changes authorized or performed by this audit.
