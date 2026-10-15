import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../src/server.js"), "utf8");

function routeBlocks() {
  const starts = [...source.matchAll(/app\.(get|post|patch|put|delete)\(\s*["']([^"']+)["']/g)];
  return starts.map((match, index) => ({
    method: match[1].toUpperCase(),
    path: match[2],
    body: source.slice(match.index, starts[index + 1]?.index ?? source.length)
  }));
}

test("every client/case/hearing/action/document mutation audits before commit", () => {
  const writes = routeBlocks().filter(({ method, path }) =>
    ["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
    /^\/api\/(clients|cases|hearings|actions|case-documents)(\/|$)/.test(path)
  );

  assert.equal(writes.length, 15, "the expected resource mutation routes should be covered");

  for (const route of writes) {
    const auditAt = route.body.indexOf("writeAuditLog(");
    const commitAt = route.body.indexOf('query("commit")');
    assert.notEqual(auditAt, -1, `${route.method} ${route.path} must write an audit row`);
    assert.notEqual(commitAt, -1, `${route.method} ${route.path} must commit its transaction`);
    assert.ok(auditAt < commitAt, `${route.method} ${route.path} must write the audit row before commit`);
    assert.ok(route.body.includes('query("begin")') || route.body.includes('query("begin");'),
      `${route.method} ${route.path} must start a transaction`);
  }
});

test("audit metadata must not serialize request payloads or secrets", () => {
  const calls = [...source.matchAll(/writeAuditLog\(([\s\S]*?)\);/g)].map(match => match[1]);
  assert.ok(calls.length >= 15, "expected audit calls for resource mutation routes");

  for (const call of calls) {
    assert.doesNotMatch(call, /req\.body|JSON\.stringify\s*\(\s*(?:req\.body|data|p\.data)\s*\)/,
      "audit metadata must not contain a serialized request payload");
    assert.doesNotMatch(call, /password|password_hash|sessionToken|csrfToken|authorization/i,
      "audit metadata must not include credentials or tokens");
  }
});
