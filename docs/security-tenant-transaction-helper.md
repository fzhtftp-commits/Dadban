# Tenant transaction helper — implementation note

This branch adds `withOfficeTransaction(pool, officeId, callback)`, which
validates the authenticated office UUID and sets `app.current_office_id`
using PostgreSQL's transaction-local `set_config(..., true)` setting.

## Current migration status

The helper is now used by these read paths in `backend/src/server.js`:

- Dashboard aggregates, recent cases, and upcoming hearings
- Client list, national-ID lookup, and client detail
- Case list and case detail

The client and case create/update/delete handlers now set the same
transaction-local office context after `BEGIN`. Case update validates a
replacement client inside that same transaction.

## Critical remaining blockers

This is still an incomplete migration and is not ready to merge or deploy.

- Authentication bootstrap still queries sessions/users before the office
  context can be established; `requireAuth` also updates session activity.
- Registration, login, logout, and session lifecycle queries need an explicit,
  tested policy/role strategy. Do not make authentication tables broadly
  accessible just to make RLS pass.
- A route-by-route review and automated regression tests are still needed to
  prove that every tenant query uses the transaction client and that data from
  a different office cannot be read, changed, or deleted.
- The runtime database role must be identified and replaced with a dedicated
  least-privilege role that does not have `BYPASSRLS`, where supported by the
  Supabase connection model.
- Policies must be designed and tested against a staging database before any
  production RLS rollout. The helper alone is not an authorization boundary.

Existing explicit `office_id` predicates should remain in place as an
additional safeguard.

## Tests

Run from `backend`:

```sh
npm install
npm test
node --check src/server.js
```

The existing helper unit tests and GitHub Actions run passed before the most
recent endpoint edits. A fresh green run for the latest commit has not yet
been confirmed. Do not merge or deploy until CI is green and staging isolation
tests pass.
