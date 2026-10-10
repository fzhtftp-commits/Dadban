import test from "node:test";
import assert from "node:assert/strict";
import { withOfficeTransaction } from "../src/db/tenant-transaction.js";

const officeId = "11111111-1111-4111-8111-111111111111";

function makePool({ failAt } = {}) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (failAt && sql === failAt) throw new Error("simulated failure");
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ sql: "RELEASE" });
    }
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("sets office context inside the transaction and releases client after commit", async () => {
  const { calls, pool } = makePool();
  const result = await withOfficeTransaction(pool, officeId, async (client) => {
    calls.push({ sql: "TENANT_QUERY" });
    return client === undefined ? null : "ok";
  });

  assert.equal(result, "ok");
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls[1].sql, "SELECT set_config('app.current_office_id', $1, true)");
  assert.deepEqual(calls[1].values, [officeId]);
  assert.equal(calls[2].sql, "TENANT_QUERY");
  assert.equal(calls[3].sql, "COMMIT");
  assert.equal(calls[4].sql, "RELEASE");
});

test("rejects invalid office ID before acquiring a connection", async () => {
  let connectCalls = 0;
  const pool = { async connect() { connectCalls += 1; throw new Error("should not connect"); } };

  await assert.rejects(
    withOfficeTransaction(pool, "not-an-uuid", async () => "unreachable"),
    /valid authenticated office ID/
  );
  assert.equal(connectCalls, 0);
});

test("rolls back and releases client if a tenant query fails", async () => {
  const { calls, pool } = makePool({ failAt: "TENANT_QUERY" });

  await assert.rejects(
    withOfficeTransaction(pool, officeId, async () => {
      await pool.connect; // Keep the callback asynchronous without external dependencies.
      throw new Error("simulated callback failure");
    }),
    /simulated callback failure/
  );

  assert.equal(calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("rolls back if setting the transaction-local context fails", async () => {
  const { calls, pool } = makePool({
    failAt: "SELECT set_config('app.current_office_id', $1, true)"
  });

  await assert.rejects(
    withOfficeTransaction(pool, officeId, async () => "unreachable"),
    /simulated failure/
  );

  assert.equal(calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(calls.at(-1).sql, "RELEASE");
});
