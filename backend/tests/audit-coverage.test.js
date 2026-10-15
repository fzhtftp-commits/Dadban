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

const mutationRoutes = () => routeBlocks().filter(({ method, path }) =>
  ["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
  /^\/api\/(auth\/(register|login|logout)|clients|cases|hearings|actions|case-documents)(\/|$)/.test(path)
);

test("every state-changing API route audits before commit", () => {
  const writes = mutationRoutes();
  assert.equal(writes.length, 18, "all auth, session, and resource mutation routes should be covered");

  for (const route of writes) {
    const routeName = route.method + " " + route.path;
    const auditAt = route.body.indexOf("writeAuditLog(");
    const commitPositions = [...route.body.matchAll(/query\(["']commit["']\)/g)].map(match => match.index);
    assert.notEqual(auditAt, -1, routeName + " must write an audit row for its mutation path");
    assert.ok(commitPositions.length > 0, routeName + " must commit its transaction");
    assert.ok(commitPositions.some(position => position > auditAt),
      routeName + " must write the audit row before committing the mutation");
    assert.ok(/query\(["']begin["']\)/.test(route.body),
      routeName + " must start a transaction");
  }
});

test("audit metadata must not serialize request payloads or secrets", () => {
  const calls = [...source.matchAll(/writeAuditLog\(([\s\S]*?)\);/g)].map(match => match[1]);
  assert.ok(calls.length >= 18, "expected audit calls for all state-changing API routes");

  for (const call of calls) {
    assert.doesNotMatch(call, /req\.body|JSON\.stringify\s*\(\s*(?:req\.body|data|p\.data)\s*\)/,
      "audit metadata must not contain a serialized request payload");
    assert.doesNotMatch(call, /password|password_hash|sessionToken|csrfToken|authorization/i,
      "audit metadata must not include credentials or tokens");
  }
});

test("audit-write failures must take the mutation route's rollback path", () => {
  for (const route of mutationRoutes()) {
    const routeName = route.method + " " + route.path;
    const auditAt = route.body.indexOf("writeAuditLog(");
    assert.notEqual(auditAt, -1, routeName + " must contain an audit write");

    const catchAt = route.body.indexOf("catch", auditAt);
    assert.notEqual(catchAt, -1, routeName + " must catch audit-write errors");
    const finallyAt = route.body.indexOf("finally", catchAt);
    const catchBody = route.body.slice(catchAt, finallyAt === -1 ? undefined : finallyAt);
    assert.match(catchBody, /rollbackQuietly\s*\(|query\(["']rollback["']\)/,
      routeName + " must roll back when the audit write fails");
  }
});
