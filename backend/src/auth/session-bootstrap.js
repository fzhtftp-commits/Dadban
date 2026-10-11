/**
 * Narrow authentication-bootstrap lookup.
 *
 * This lookup necessarily runs before tenant context is known. Keep it limited
 * to one unguessable token hash and require the session/user office relationship
 * to match. It must not be treated as a substitute for a least-privilege runtime
 * database role or a reviewed RLS bootstrap strategy.
 */
export async function findActiveSession(pool, tokenHash) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A PostgreSQL pool is required");
  }
  if (typeof tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new TypeError("A SHA-256 session token hash is required");
  }

  return pool.query(
    `
      select s.id as session_id, s.user_id, s.office_id, s.csrf_hash,
             u.full_name, u.email, u.role
      from auth_sessions s
      join users u
        on u.id = s.user_id
       and u.office_id = s.office_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and u.is_active = true
        and u.deleted_at is null
      limit 1
    `,
    [tokenHash]
  );
}
