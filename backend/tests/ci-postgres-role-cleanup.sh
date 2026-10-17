#!/usr/bin/env bash
set -euo pipefail

# This cleanup is intentionally scoped to the ephemeral PostgreSQL service
# used by case-documents-tests.yml. Never run it against an operational DB.
if [[ "${PGHOST:-localhost}" != "localhost" && "${PGHOST:-localhost}" != "127.0.0.1" ]]; then
  echo "Refusing CI role cleanup against non-local PostgreSQL" >&2; exit 2
fi
if [[ "${PGDATABASE:-dadban_test}" != "dadban_test" ]]; then
  echo "Refusing CI role cleanup outside dadban_test" >&2; exit 2
fi
: "${PGPASSWORD:?PGPASSWORD must be set for disposable PostgreSQL}"
PSQL=(psql -h localhost -U postgres -d dadban_test -X -v ON_ERROR_STOP=1)

roles=(
  anon authenticated
  dadban_rate_limiter_ci
  dadban_actor_runtime_ci dadban_actor_lock_owner_ci
  dadban_document_runtime_ci dadban_document_runtime_alt_ci
  dadban_case_documents_owner_ci dadban_case_documents_migrator_ci
  dadban_schema_owner_ci dadban_schema_owner_alt_ci
  dadban_migrator_ci dadban_maintenance_ci
)

# Restore all objects owned by test roles to postgres in this disposable DB,
# then remove per-database grants/objects. Cluster roles themselves are dropped
# only after role memberships have been revoked.
for role in "${roles[@]}"; do
  exists="$("${PSQL[@]}" -Atqc "SELECT 1 FROM pg_roles WHERE rolname='$role'")"
  if [[ "$exists" == "1" ]]; then
    "${PSQL[@]}" -c "REASSIGN OWNED BY \"$role\" TO postgres" >/dev/null
    "${PSQL[@]}" -c "DROP OWNED BY \"$role\"" >/dev/null
  fi
done

"${PSQL[@]}" <<'SQL'
DO $cleanup_memberships$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_auth_members m
    JOIN pg_roles granted ON granted.oid=m.roleid
    JOIN pg_roles member ON member.oid=m.member
    WHERE granted.rolname = ANY (ARRAY[
      'anon','authenticated','dadban_rate_limiter_ci',
      'dadban_actor_runtime_ci','dadban_actor_lock_owner_ci',
      'dadban_document_runtime_ci','dadban_document_runtime_alt_ci',
      'dadban_case_documents_owner_ci','dadban_case_documents_migrator_ci',
      'dadban_schema_owner_ci','dadban_schema_owner_alt_ci',
      'dadban_migrator_ci','dadban_maintenance_ci'
    ])
    OR member.rolname = ANY (ARRAY[
      'anon','authenticated','dadban_rate_limiter_ci',
      'dadban_actor_runtime_ci','dadban_actor_lock_owner_ci',
      'dadban_document_runtime_ci','dadban_document_runtime_alt_ci',
      'dadban_case_documents_owner_ci','dadban_case_documents_migrator_ci',
      'dadban_schema_owner_ci','dadban_schema_owner_alt_ci',
      'dadban_migrator_ci','dadban_maintenance_ci'
    ])
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
  END LOOP;
END
$cleanup_memberships$;
SQL

for role in "${roles[@]}"; do
  "${PSQL[@]}" -c "DROP ROLE IF EXISTS \"$role\"" >/dev/null
done

leftovers="$("${PSQL[@]}" -Atqc "
SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname), '')
FROM pg_roles
WHERE rolname = ANY (ARRAY[
  'anon','authenticated','dadban_rate_limiter_ci',
  'dadban_actor_runtime_ci','dadban_actor_lock_owner_ci',
  'dadban_document_runtime_ci','dadban_document_runtime_alt_ci',
  'dadban_case_documents_owner_ci','dadban_case_documents_migrator_ci',
  'dadban_schema_owner_ci','dadban_schema_owner_alt_ci',
  'dadban_migrator_ci','dadban_maintenance_ci'
])")"
if [[ -n "$leftovers" ]]; then
  echo "FAIL: test-only cluster roles remain after cleanup: $leftovers" >&2
  exit 1
fi

echo "PASS: CI cleanup reassigns test-owned objects, drops grants and memberships, and leaves no test-only cluster roles"
