import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const hearingUi = read("../../hearings.js");
const calendarHtml = read("../../calendar.html");
const caseProfileHtml = read("../../case-profile.html");
const caseProfileJs = read("../../case-profile.js");
const dashboardHtml = read("../../index.html");
const casesHtml = read("../../cases.html");
const clientsHtml = read("../../clients.html");
const schema = read("../../database/schema.sql");
const server = read("../src/server.js");

test("case profile opens the calendar scoped to its own case", () => {
  assert.match(caseProfileHtml, /id="caseHearingsLink"/);
  assert.match(caseProfileJs, /calendar\.html\?case_id=/);
  assert.match(caseProfileJs, /encodeURIComponent\(c\.id\)/);
  assert.match(hearingUi, /get\("case_id"\)/);
  assert.match(hearingUi, /params\.set\("case_id",selectedCaseId\)/);
});

test("calendar case filter is independent of the create/edit form and clears correctly", () => {
  assert.match(calendarHtml, /id="filterCaseId"/);
  assert.match(calendarHtml, /id="caseId"/);
  assert.match(hearingUi, /\$\("filterCaseId"\)\.addEventListener\("change",loadHearings\)/);
  assert.match(hearingUi, /\$\("clearFilters"\).*?\$\("filterCaseId"\)\.value=""/);
  assert.match(hearingUi, /\$\("caseId"\)\.innerHTML/);
});

test("dashboard and primary management pages link to the calendar", () => {
  for (const [name, html] of [
    ["dashboard", dashboardHtml],
    ["case list", casesHtml],
    ["client list", clientsHtml],
    ["case profile", caseProfileHtml],
    ["calendar", calendarHtml]
  ]) {
    assert.match(html, /href="calendar\.html(?:\?[^"]*)?"/, name + " should have a working calendar link");
  }
  assert.match(dashboardHtml, /upcomingHearingsBody/);
  assert.match(read("../../app.js"), /calendar\\.html\\?case_id=/);
  assert.match(dashboardHtml, /href="calendar\.html">تقویم/);
});

test("calendar UI fields and API validation remain compatible with the SQL schema", () => {
  for (const field of [
    "office_id", "case_id", "hearing_at", "hearing_type", "court_name",
    "branch_name", "status", "reminder_minutes", "notes", "created_by",
    "updated_by", "created_at", "updated_at", "deleted_at"
  ]) {
    assert.match(schema, new RegExp("\\b" + field + "\\b"), "schema should include " + field);
  }
  for (const status of ["scheduled", "completed", "cancelled", "postponed"]) {
    assert.ok(schema.includes("'" + status + "'"), "schema should permit " + status);
    assert.ok(server.includes('"' + status + '"'), "API should permit " + status);
  }
  assert.match(schema, /reminder_minutes integer not null default 1440/);
  assert.match(schema, /check \(reminder_minutes >= 0 and reminder_minutes <= 43200\)/);
});
