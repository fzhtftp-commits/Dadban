import test from "node:test";
import assert from "node:assert/strict";
import {
  findActiveSession,
  findLoginUser,
  createAuthSession,
  registerAuthAccount,
  updateAuthSession
} from "../src/auth/auth-bootstrap.js";

const hash = "a".repeat(64);
const officeId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function fakeQueryable(result = { rows: [], rowCount: 0 }) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return result;
    }
  };
}

test("session lookup calls only the narrow database function", async () => {
  const db = fakeQueryable();
  await findActiveSession(db, hash);
  assert.match(db.calls[0].sql, /dadban_auth_session_lookup\(\$1\)/);
  assert.deepEqual(db.calls[0].values, [hash]);
});

test("login lookup normalizes email and does not issue a direct credentials query", async () => {
  const db = fakeQueryable();
  await findLoginUser(db, "  LAWYER@EXAMPLE.COM ");
  assert.match(db.calls[0].sql, /dadban_auth_login_lookup\(\$1\)/);
  assert.deepEqual(db.calls[0].values, ["lawyer@example.com"]);
  assert.doesNotMatch(db.calls[0].sql, /auth_credentials/i);
});

test("rejects malformed token hashes before touching the database", async () => {
  const db = fakeQueryable();
  await assert.rejects(findActiveSession(db, "bad"), /SHA-256 session token hash/);
  assert.equal(db.calls.length, 0);
});

test("creates a session only through the database function", async () => {
  const db = fakeQueryable({ rows: [{ created: true }], rowCount: 1 });
  await createAuthSession(db, { userId, officeId, tokenHash: hash, csrfHash: hash });
  assert.match(db.calls[0].sql, /dadban_auth_create_session/);
  assert.deepEqual(db.calls[0].values, [userId, officeId, hash, hash]);
});

test("registration mediates all four account records through one database function", async () => {
  const db = fakeQueryable({ rows: [{ id: userId, office_id: officeId }], rowCount: 1 });
  await registerAuthAccount(db, {
    fullName: "Test Owner",
    email: "OWNER@EXAMPLE.COM",
    officeName: "Test Office",
    passwordHash: "scrypt$16384$8$1$salt$hash",
    tokenHash: hash,
    csrfHash: hash
  });
  assert.match(db.calls[0].sql, /dadban_auth_register/);
  assert.deepEqual(db.calls[0].values, [
    "Test Owner", "owner@example.com", "Test Office", "scrypt$16384$8$1$salt$hash", hash, hash
  ]);
});

test("session update accepts only touch or revoke actions", async () => {
  const db = fakeQueryable({ rows: [{ updated: true }], rowCount: 1 });
  await updateAuthSession(db, { sessionId: userId, officeId, action: "revoke" });
  assert.match(db.calls[0].sql, /dadban_auth_update_session/);
  await assert.rejects(
    updateAuthSession(db, { sessionId: userId, officeId, action: "delete" }),
    /Unsupported session action/
  );
  assert.equal(db.calls.length, 1);
});
