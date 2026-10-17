import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const helper = readFileSync(new URL("../../idempotency-client.js", import.meta.url), "utf8");

function createClient() {
  const values = new Map();
  let counter = 0;
  const window = {
    location: { href: "https://fzhtftp-commits.github.io/calendar.html" },
    crypto: { randomUUID: () => `uuid-${++counter}` }
  };
  const sessionStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  vm.runInNewContext(helper, { window, sessionStorage, URL, Math, Date, JSON, String, Object });
  return { window, sessionStorage, values, setUser: user => sessionStorage.setItem("dadban_user", JSON.stringify(user)) };
}

test("frontend reuses one idempotency key for the same pending mutation", () => {
  const client = createClient();
  client.setUser({ id: "user-a" });
  const body = JSON.stringify({ title: "Case", client_id: "client-1" });
  const first = client.window.dadbanWithMutationKey("/api/cases", { method: "POST", body, headers: { "Content-Type": "application/json" } });
  const retry = client.window.dadbanWithMutationKey("/api/cases", { method: "POST", body, headers: { "Content-Type": "application/json" } });
  assert.equal(first.key, retry.key);
  assert.equal(first.options.headers["Idempotency-Key"], first.key);
  assert.equal(first.options.headers["Content-Type"], "application/json");
});

test("frontend creates distinct keys for different mutations and user scopes", () => {
  const client = createClient();
  client.setUser({ id: "user-a" });
  const first = client.window.dadbanMutationKey("/api/cases", "POST", JSON.stringify({ title: "A" }));
  const changedBody = client.window.dadbanMutationKey("/api/cases", "POST", JSON.stringify({ title: "B" }));
  const otherResource = client.window.dadbanMutationKey("/api/clients", "POST", JSON.stringify({ title: "A" }));
  client.setUser({ id: "user-b" });
  const otherUser = client.window.dadbanMutationKey("/api/cases", "POST", JSON.stringify({ title: "A" }));
  assert.notEqual(first, changedBody);
  assert.notEqual(first, otherResource);
  assert.notEqual(first, otherUser);
});

test("frontend clears a pending key only after the matching mutation succeeds", () => {
  const client = createClient();
  client.setUser({ id: "user-a" });
  const body = JSON.stringify({ title: "Case" });
  const key = client.window.dadbanMutationKey("/api/cases", "POST", body);
  client.window.dadbanMutationSucceeded("/api/cases", "POST", body, "not-the-key");
  assert.equal(client.window.dadbanMutationKey("/api/cases", "POST", body), key);
  client.window.dadbanMutationSucceeded("/api/cases", "POST", body, key);
  assert.notEqual(client.window.dadbanMutationKey("/api/cases", "POST", body), key);
});

test("frontend does not attach idempotency keys to read-only requests", () => {
  const client = createClient();
  const read = client.window.dadbanWithMutationKey("/api/cases", { method: "GET", headers: { Accept: "application/json" } });
  assert.equal(read.key, null);
  assert.equal(read.options.headers["Idempotency-Key"], undefined);
});
