# Dadban authentication bootstrap boundary

Status: isolated implementation and unit tests only. Not a production-ready RLS
configuration. Do not merge/deploy or enable additional RLS policies based only
on this document.

## Implemented on this branch

- The active-session lookup is isolated in `backend/src/auth/session-bootstrap.js`.
- It accepts only a SHA-256 token hash, filters revoked/expired sessions and
  inactive/deleted users, and explicitly requires `users.office_id` to match
  `auth_sessions.office_id`.
- The focused unit test checks the query's security predicates and verifies
  malformed token hashes are rejected before the database is queried.
- Session activity and logout writes use office-scoped transactions after the
  office ID has been established.

## Why this does not finish the RLS migration

The session lookup happens before trusted tenant context is known. The current
shared runtime connection has been configured with the Supabase pooler
`postgres.<project-ref>` identity; the SQL Editor's role result is not proof
of the exact runtime privileges, but the current connection strategy must be
treated as unsafe for an RLS rollout until independently verified. Do not
grant broad cross-office reads to compensate for the bootstrap problem.

Registration and login also create or read records before tenant context is
available. A safe target requires a dedicated runtime role with no
`BYPASSRLS`, least-privilege grants, and a narrowly scoped reviewed bootstrap
mechanism for registration, login, session resolution, session activity and
logout. Any `SECURITY DEFINER` functions must have a fixed safe
`search_path`, a tightly controlled owner, explicit grants, and no dynamic SQL
from user input.

## Required validation before merge

1. Run `npm install`, `npm test`, and `node --check src/server.js` in CI.
2. In a separate staging Supabase project, verify the actual Render-equivalent
   runtime role and its grants without sharing credentials in chat.
3. Test registration, successful/failed login, session expiry/revocation,
   `/api/auth/me`, logout, CSRF, and concurrent requests.
4. Test two offices: each must be unable to read or mutate the other's users,
   credentials, sessions, clients, cases, hearings, or audit logs.
5. Verify missing tenant context denies tenant data access and pooled connections
   do not retain a previous office's context.
6. Review the final role grants, functions, policies, migration order and
   rollback plan before any production change.

No live database role, function, grant, or RLS policy is changed by this branch.
