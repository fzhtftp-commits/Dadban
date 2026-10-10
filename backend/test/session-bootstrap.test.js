import test from "node:test";
import assert from "node:assert/strict";
import { findActiveSession } from "../src/auth/session-bootstrap.js";

const tokenHash = "a".repeat(64);

test("looks up one active session by token hash and matches user to session office", async () => {
  let captured;
  const expected = { rowCount: 1, rows: [{ session_id: "s1", office_id: "o1" }] };
  const pool = {
    async query(sql, values) {
      captured = { sql, values };
      return expected;
    }
  };

  const result = await findActiveSession(pool, tokenHash);

  assert.equal(result, expected);
  assert.deepEqual(captured.values, [tokenHash]);
  assert.match(captured.sql, /s\.token_hash = \$1/);
  assert.match(captured.sql, /u\.office_id = s\.office_id/);
  assert.match(captured.sql, /s\.revoked_at is null/);
  assert.match(captured.sql, /s\.expires_at > now\(\)/);
  assert.match(captured.sql, /u\.is_active = true/);
  assert.match(captured.sql, /u\.deleted_at is null/);
  assert.match(captured.sql, /limit 1/i);
});

test("rejects malformed token hashes without querying the database", async () => {
  let queryCalls = 0;
  const pool = { async query() { queryCalls += 1; } };

  await assert.rejects(findActiveSession(pool, "not-a-hash"), /SHA-256 session token hash/);
  assert.equal(queryCalls, 0);
});

test("requires a query-capable pool", async () => {
  await assert.rejects(findActiveSession(null, tokenHash), /PostgreSQL pool/);
});
