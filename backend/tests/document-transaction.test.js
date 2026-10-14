import test from "node:test";
import assert from "node:assert/strict";
import { rollbackQuietly, releaseClient } from "../src/document-transaction.js";

test("successful rollback leaves client reusable until final release", async () => {
  let rollbackCalls = 0;
  let releaseCalls = 0;
  const client = {
    async query(sql) { assert.equal(sql, "rollback"); rollbackCalls++; },
    release(error) { assert.equal(error, undefined); releaseCalls++; }
  };
  assert.equal(await rollbackQuietly(client, "unit success"), true);
  assert.equal(rollbackCalls, 1);
  assert.equal(releaseCalls, 0);
  releaseClient(client);
  releaseClient(client);
  assert.equal(releaseCalls, 1, "client should be released exactly once");
});

test("rollback failure discards client and never throws to the request handler", async () => {
  const rollbackError = new Error("simulated rollback connection failure");
  let releaseCalls = 0;
  let releaseArgument;
  const client = {
    async query() { throw rollbackError; },
    release(error) { releaseCalls++; releaseArgument = error; }
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await rollbackQuietly(client, "unit failure"), false);
  } finally {
    console.error = originalError;
  }
  assert.equal(releaseCalls, 1);
  assert.equal(releaseArgument, rollbackError, "failed rollback must discard the pooled client");
  releaseClient(client);
  assert.equal(releaseCalls, 1, "finally cleanup must not double-release discarded client");
});

test("rollback helper safely handles a missing client", async () => {
  assert.equal(await rollbackQuietly(null, "no connection"), false);
  releaseClient(null);
});
