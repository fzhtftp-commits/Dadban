# Tenant transaction helper — implementation note

This branch adds a tested transaction helper that sets `app.current_office_id`
using PostgreSQL's transaction-local `set_config(..., true)` setting.

## Critical limitation

This helper is not yet wired into `server.js`. It does not protect any endpoint
until every tenant-data query is moved onto the callback's same client and the
matching RLS policies are installed. Existing calls through `pool.query` do not
inherit this transaction context.

The setting is intended as defense in depth against accidentally omitted
`office_id` predicates. It is not a substitute for trusted authentication,
least-privilege database roles, SQL-injection prevention, or separate controls
for registration/login/session bootstrap.

## Tests

Run from `backend`:

```sh
node --test
```

Do not deploy or apply database policies based on this helper alone. The next
step is to refactor endpoints and auth bootstrap, then test using a dedicated
non-BYPASSRLS role against a staging database.
