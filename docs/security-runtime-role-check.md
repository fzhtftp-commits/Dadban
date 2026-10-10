# Read-only runtime database role check

This check is intended to identify the effective PostgreSQL role used by the Dadban backend connection. The role shown in Supabase SQL Editor is not proof of the role used by Render.

## Safety properties

- This is a command-line script, not an HTTP endpoint.
- It performs read-only catalog/privilege queries.
- It prints the database role name, role flags, and grants for Dadban tables.
- It never prints the connection string, password, host, or other connection parameters.
- It does not create roles, change grants, enable/disable RLS, or alter data.

## Run it only in a trusted backend environment

Run it in the same environment and with the same `DATABASE_URL` configuration as the deployed backend. If the Render service provides a Shell, use the service's shell and repository checkout, navigate to the `backend` directory, then run:

```sh
node scripts/check-db-runtime-role.js
```

Do not paste the connection string into the command, source code, chat, or logs. The script reads `DATABASE_URL` from the existing environment. If Render does not provide a shell for the current service/plan, do not expose a public diagnostic endpoint as a workaround; use a trusted one-off execution environment configured through the platform's secret environment variables.

## What to review

- `bypasses_rls: true` means PostgreSQL row-level security policies can be bypassed by this role; do not treat RLS policies alone as tenant isolation for this connection.
- `is_superuser: true` is an even stronger privilege warning.
- Review the table privileges against least privilege. In particular, auth/bootstrap access should be narrow and deliberate.
- The result describes the connection used to run the script. Make sure that connection uses the same environment variable and pooler settings as the backend service.

## Important

This diagnostic is only one prerequisite. It does not prove tenant isolation and does not make the current branch production-ready. Do not enable additional RLS policies, change production grants, merge the draft PR, or deploy based only on this output. The next stage requires an agreed auth/bootstrap design and staging tests for registration, login, session resolution/revocation, missing tenant context, connection-pool reuse, and cross-office access.
