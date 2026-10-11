/**
 * Narrow authentication bootstrap API.
 *
 * These calls are intended to be backed by database SECURITY DEFINER functions
 * owned by a dedicated NOLOGIN, NOBYPASSRLS role. They are not safe to deploy
 * until the matching migration and dadban_runtime grants are reviewed/applied.
 */
const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function requirePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("A PostgreSQL query-capable pool is required");
  }
}

export async function findActiveSession(pool, tokenHash) {
  requirePool(pool);
  if (!isSha256(tokenHash)) throw new TypeError("A SHA-256 session token hash is required");
  return pool.query(
    "select * from public.dadban_auth_session_lookup($1)",
    [tokenHash]
  );
}

export async function findLoginUser(pool, email) {
  requirePool(pool);
  if (typeof email !== "string" || !email.trim() || email.length > 320) {
    throw new TypeError("A valid email address is required");
  }
  return pool.query(
    "select * from public.dadban_auth_login_lookup($1)",
    [email.trim().toLowerCase()]
  );
}

export async function createAuthSession(queryable, { userId, officeId, tokenHash, csrfHash }) {
  if (!queryable || typeof queryable.query !== "function") {
    throw new TypeError("A PostgreSQL query-capable client is required");
  }
  if (!isSha256(tokenHash) || !isSha256(csrfHash)) {
    throw new TypeError("SHA-256 token hashes are required");
  }
  return queryable.query(
    "select public.dadban_auth_create_session($1, $2, $3, $4) as created",
    [userId, officeId, tokenHash, csrfHash]
  );
}

export async function registerAuthAccount(queryable, {
  fullName, email, officeName, passwordHash, tokenHash, csrfHash
}) {
  if (!queryable || typeof queryable.query !== "function") {
    throw new TypeError("A PostgreSQL query-capable client is required");
  }
  if (!isSha256(tokenHash) || !isSha256(csrfHash)) {
    throw new TypeError("SHA-256 token hashes are required");
  }
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("scrypt$")) {
    throw new TypeError("A supported password hash is required");
  }
  return queryable.query(
    "select * from public.dadban_auth_register($1, $2, $3, $4, $5, $6)",
    [fullName, email.trim().toLowerCase(), officeName, passwordHash, tokenHash, csrfHash]
  );
}

export async function updateAuthSession(queryable, { sessionId, officeId, action }) {
  if (!queryable || typeof queryable.query !== "function") {
    throw new TypeError("A PostgreSQL query-capable client is required");
  }
  if (!["touch", "revoke"].includes(action)) {
    throw new TypeError("Unsupported session action");
  }
  return queryable.query(
    "select public.dadban_auth_update_session($1, $2, $3) as updated",
    [sessionId, officeId, action]
  );
}
