import test from "node:test";
import assert from "node:assert/strict";
import { acquireClient, rollbackQuietly, releaseClient } from "../src/document-transaction.js";

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

test("reused pool client can be released once per checkout", async () => {
  let releaseCalls = 0;
  const client = {
    async query() {},
    release() { releaseCalls++; }
  };
  const pool = { async connect() { return client; } };
  const firstCheckout = await acquireClient(pool);
  releaseClient(firstCheckout);
  releaseClient(firstCheckout);
  assert.equal(releaseCalls, 1, "duplicate cleanup in one checkout must be ignored");
  const secondCheckout = await acquireClient(pool);
  assert.equal(secondCheckout, client, "pool may reuse the same client object");
  releaseClient(secondCheckout);
  assert.equal(releaseCalls, 2, "reused client must be released for the new checkout");
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


test("rollback failure logs omit raw exception messages", async () => {
  const secret = "postgres://private-user:private-password@db.internal/private-db";
  const rollbackError = new Error(secret);
  rollbackError.code = "08006";
  const captured = [];
  const original = console.error;
  console.error = (...args) => captured.push(args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
  const client = {
    async query() { throw rollbackError; },
    release() {}
  };
  try {
    assert.equal(await rollbackQuietly(client, "log-redaction regression"), false);
  } finally {
    console.error = original;
  }
  const output = captured.join("\\n");
  assert.equal(output.includes(secret), false, "raw database connection details must not be logged");
  assert.equal(output.includes("08006"), true, "safe database error code may be retained for diagnostics");
  assert.equal(output.includes("private-password"), false);
});
