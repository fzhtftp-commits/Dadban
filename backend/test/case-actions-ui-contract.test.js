import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../../actions.html");
const ui = read("../../actions.js");
const profileHtml = read("../../case-profile.html");
const profileJs = read("../../case-profile.js");
const schema = read("../../database/schema.sql");
const migration = read("../../database/migrations/20261014_case_actions.sql");
const server = read("../src/server.js");
const workflow = read("../../.github/workflows/feature-checks.yml");
const dashboardHtml = read("../../index.html");
const dashboardJs = read("../../app.js");

test("actions page is Persian, links to the current case, and exposes CRUD controls", () => {
  assert.match(page, /lang="fa" dir="rtl"/);
  for (const id of ["actionForm","caseId","assignedTo","actionTitle","actionDescription","dueAt","actionStatus","actionPriority","actionsBody","filterCaseId","filterStatus"]) {
    assert.match(page, new RegExp('id="' + id + '"'));
  }
  assert.match(profileHtml, /id="caseActionsLink"/);
  assert.ok(profileJs.includes("actions.html?case_id="));
  assert.ok(ui.includes('get("case_id")'));
  assert.match(dashboardHtml, /id="upcomingActionsBody"/);
  assert.ok(dashboardJs.includes("/api/actions?limit=50"));
  assert.ok(dashboardJs.includes("actions.html?case_id="));
  assert.ok(dashboardJs.includes("overdue-summary"));
  assert.ok(dashboardJs.includes("overdue-event"));
  assert.ok(dashboardJs.includes("is_overdue"));
  assert.ok(profileHtml.includes('id="caseActionsList"'));
  assert.ok(profileHtml.includes('id="caseActionsSummary"'));
  assert.ok(profileJs.includes("/api/actions?case_id="));
  assert.ok(profileJs.includes("مهلت گذشته"));
  assert.ok(profileJs.includes("caseActionsAllLink"));
});

test("actions UI uses authenticated requests, CSRF for writes, and clear error messages", () => {
  assert.match(ui, /credentials:"include"/);
  assert.match(ui, /"x-csrf-token":csrf\(\)/);
  assert.match(ui, /response.status===401/);
  for (const code of ["csrf_token_required","csrf_token_invalid","origin_not_allowed","invalid_related_case","invalid_assignee","invalid_action","action_not_found","authentication_required"]) {
    assert.ok(ui.includes(code), "UI should handle " + code);
  }
  assert.ok(ui.includes("/api/actions/assignees"));
  assert.ok(ui.includes("is_overdue"));
  assert.ok(ui.includes("overdue-badge"));
  assert.match(ui, /textContent=text/);
  assert.match(ui, /esc\(a\.title\)/);
});

test("case_actions schema enforces office/case and office/assignee relationships", () => {
  for (const field of ["office_id","case_id","title","description","due_at","status","priority","assigned_to","created_by","updated_by","completed_at","created_at","updated_at","deleted_at"]) {
    assert.ok(schema.includes(field), "schema missing " + field);
    assert.ok(migration.includes(field), "migration missing " + field);
  }
  assert.match(schema, /foreign key \(case_id, office_id\) references cases\(id, office_id\)/);
  assert.match(schema, /foreign key \(assigned_to, office_id\) references users\(id, office_id\)/);
  for (const status of ["todo","in_progress","completed","cancelled"]) {
    assert.ok(schema.includes("'" + status + "'"));
    assert.ok(server.includes('"' + status + '"'));
  }
});

test("assignee API is limited to active users in the current office", () => {
  assert.ok(server.includes('/api/actions/assignees'));
  assert.ok(server.includes("office_id = $1 and is_active = true and deleted_at is null"));
});

test("case action API is office-scoped, validates input, and audits changes", () => {
  for (const route of ['"/api/actions"','"/api/actions/:id"']) assert.ok(server.includes(route));
  assert.match(server, /app\.post\("\/api\/actions", requireAuth, requireTrustedOrigin, requireCsrf/);
  assert.match(server, /app\.patch\("\/api\/actions\/:id", requireAuth, requireTrustedOrigin, requireCsrf/);
  assert.match(server, /app\.delete\("\/api\/actions\/:id", requireAuth, requireTrustedOrigin, requireCsrf/);
  assert.match(server, /a\.office_id = \$1/);
  assert.ok(server.includes('"case_action"'));
  assert.match(workflow, /feature\/case-actions/);
  assert.ok(workflow.includes("case-actions-ui-contract.test.js"));
});
