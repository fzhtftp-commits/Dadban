import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const page = read("../../documents.html");
const ui = read("../../documents.js");
const server = read("../src/server.js");
const schema = read("../../database/schema.sql");
const migration = read("../../database/migrations/20261014_case_documents_metadata.sql");
const integration = read("./hearings.integration.test.js");
const workflow = read("../../.github/workflows/feature-checks.yml");
const navPages = ["../../index.html","../../cases.html","../../clients.html","../../case-profile.html","../../client-profile.html","../../case-form.html","../../client-form.html","../../calendar.html","../../actions.html"];

test("document metadata page is Persian RTL, navigable, and explicitly disables file upload", () => {
  assert.match(page, /lang="fa" dir="rtl"/);
  for (const id of ["documentForm","documentId","caseId","documentTitle","documentType","documentDate","referenceNumber","confidentiality","documentDescription","documentsBody"]) {
    assert.match(page, new RegExp('id="' + id + '"'));
  }
  assert.match(page, /آپلود و دانلود فایل هنوز فعال نیست/);
  assert.match(page, /هیچ فایل، لینک دانلود، مسیر ذخیره‌سازی یا محتوای باینری ثبت نمی‌شود/);
  assert.ok(ui.includes("/api/documents"));
  assert.ok(ui.includes("credentials:\"include\""));
  assert.ok(ui.includes('"x-csrf-token":csrf()'));
  assert.ok(ui.includes("data-document-edit"));
  assert.ok(ui.includes("data-document-delete"));
  for (const path of navPages) assert.match(read(path), /href="documents.html">▤ اسناد و مدارک/);
  assert.ok(read("../../case-profile.js").includes("documents.html?case_id="));
});

test("metadata schema enforces office/case isolation and no file storage", () => {
  for (const field of ["office_id","case_id","title","document_type","description","document_date","reference_number","confidentiality","storage_status","created_by","updated_by","deleted_at"]) {
    assert.ok(schema.includes(field), "schema missing " + field);
    assert.ok(migration.includes(field), "migration missing " + field);
  }
  assert.match(schema, /foreign key \(case_id, office_id\) references cases\(id, office_id\)/);
  assert.match(migration, /check \(storage_status = 'metadata_only'\)/);
  assert.ok(!migration.includes("storage_key"));
  assert.ok(!migration.includes("file_url"));
  assert.ok(!migration.includes("bytea"));
  assert.ok(integration.includes("caseDocumentsMigration"));
  assert.ok(integration.includes("unsupported upload fields"));
});

test("document API requires authentication, office scope, CSRF for mutations, and audit logging", () => {
  assert.match(server, /app\.get\("\/api\/documents", requireAuth/);
  assert.match(server, /app\.get\("\/api\/documents\/:id", requireAuth/);
  assert.match(server, /app\.post\("\/api\/documents", requireAuth, requireTrustedOrigin, requireCsrf/);
  assert.match(server, /app\.patch\("\/api\/documents\/:id", requireAuth, requireTrustedOrigin, requireCsrf/);
  assert.match(server, /app\.delete\("\/api\/documents\/:id", requireAuth, requireTrustedOrigin, requireCsrf/);
  assert.ok(server.includes('"case_document"'));
  assert.ok(workflow.includes("documents.js"));
  assert.ok(workflow.includes("documents-ui-contract.test.js"));
});
