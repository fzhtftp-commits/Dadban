import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const migration = await readFile(new URL("../migrations/004_case_documents_metadata.sql", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const transactionHelper = await readFile(new URL("../src/document-transaction.js", import.meta.url), "utf8");
test("schema defaults to metadata-only and enforces same-office foreign keys and size cap", () => {
 assert.match(migration, /storage_status varchar\(24\) not null default 'metadata_only'/);
 assert.match(migration, /size_bytes <= 26214400/);
 assert.match(migration, /case_documents_case_same_office_fk/);
 assert.match(migration, /case_documents_created_by_same_office_fk/);
});
test("CRUD endpoints require authentication and protect writes", () => {
 assert.match(server, /app\.get\("\/api\/case-documents", requireAuth/);
 assert.match(server, /app\.get\("\/api\/case-documents\/:id", requireAuth/);
 assert.match(server, /app\.post\("\/api\/case-documents", requireAuth, requireTrustedOrigin, requireCsrf/);
 assert.match(server, /app\.patch\("\/api\/case-documents\/:id", requireAuth, requireTrustedOrigin, requireCsrf/);
 assert.match(server, /app\.delete\("\/api\/case-documents\/:id", requireAuth, requireTrustedOrigin, requireCsrf/);
 assert.match(server, /d\.office_id = \$1/);
});
test("metadata phase does not introduce file byte upload handling", () => {
 assert.match(migration, /storage_key text/);
 assert.match(migration, /storage_status = 'metadata_only' and storage_key is null/);
 assert.doesNotMatch(server, /multer|busboy|presigned|signedUrl|uploadFile/i);
});

test("every document API route enforces office-scoped access predicates", () => {
 const route = (start, end) => {
   const i = server.indexOf(start);
   assert.notEqual(i, -1, `route not found: ${start}`);
   const j = server.indexOf(end, i);
   assert.notEqual(j, -1, `route end not found: ${end}`);
   return server.slice(i, j);
 };
 const list = route('app.get("/api/case-documents",', 'app.get("/api/case-documents/:id",');
 const detail = route('app.get("/api/case-documents/:id",', 'app.post("/api/case-documents",');
 const create = route('app.post("/api/case-documents",', 'app.patch("/api/case-documents/:id",');
 const update = route('app.patch("/api/case-documents/:id",', 'app.delete("/api/case-documents/:id",');
 const remove = route('app.delete("/api/case-documents/:id",', 'app.use((_req, res) =>');
 assert.match(list, /d\.office_id = \$1/);
 assert.match(detail, /d\.id=\$1 and d\.office_id=\$2/);
 assert.match(create, /cases where id=\$1 and office_id=\$2/);
 assert.match(update, /where id=\$\$\{v\.length-1\} and office_id=\$\$\{v\.length\}/);
 assert.match(remove, /where id=\$1 and office_id=\$2 and deleted_at is null/);
});

test("case_id list filter uses a bound SQL parameter and dates reject impossible calendar days", () => {
 assert.match(server, /where\.push\(\`d\.case_id = \$\$\{values\.length\}\`\)/);
 assert.match(server, /date\.toISOString\(\)\.slice\(0,10\) === value/);
});

test("document transactions guard rollback failures and always release acquired clients", () => {
 assert.match(server, /import \{ rollbackQuietly, releaseClient \} from "\.\/document-transaction\.js"/);
 assert.match(transactionHelper, /catch \(rollbackError\)[\s\S]*?Database rollback failed/);
 const routeStart = server.indexOf('app.post("/api/case-documents"');
 const routeEnd = server.indexOf('app.use\(\(_req, res\) =>', routeStart);
 const routes = server.slice(routeStart, routeEnd);
 assert.equal((routes.match(/finally\{releaseClient\(c\);\}/g) || []).length, 3);
 assert.equal((routes.match(/try\{c=await pool\.connect\(\)/g) || []).length, 3);
 assert.doesNotMatch(routes, /catch\(error\)\{await c\.query\("rollback"\)/);
});
test("unhandled and oversized request errors return sanitized JSON", () => {
 assert.match(server, /app\.use\(\(error, _req, res, next\) =>/);
 assert.match(server, /error: "request_too_large"/);
 assert.match(server, /error: "invalid_json"/);
 assert.match(server, /error: "internal_server_error"/);
});

test("database connections and statements have bounded timeouts", () => {
 assert.match(server, /max: 10/);
 assert.match(server, /connectionTimeoutMillis: 10000/);
 assert.match(server, /statement_timeout: Number\(process\.env\.DB_STATEMENT_TIMEOUT_MS \|\| 15000\)/);
});

test("document metadata rejects client-controlled office/case/storage fields and impossible dates", () => {
 assert.match(server, /const caseDocumentCreateSchema = z\.object\([\s\S]*?\)\.strict\(\)/);
 assert.match(server, /const caseDocumentPatchSchema = z\.object\(\{/);
 assert.match(server, /document_type: documentTypeSchema\.optional\(\)/);
 assert.match(server, /date\.toISOString\(\)\.slice\(0,10\) === value/);
 assert.match(server, /reference_number: z\.string\(\)\.trim\(\)\.max\(100\)/);
 assert.match(migration, /storage_status = 'metadata_only' and storage_key is null/);
});
