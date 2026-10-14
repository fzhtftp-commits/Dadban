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
 assert.match(server, /import \{ acquireClient, rollbackQuietly, releaseClient \} from "\.\/document-transaction\.js"/);
 assert.match(transactionHelper, /catch \(rollbackError\)[\s\S]*?Database rollback failed/);
 const routeStart = server.indexOf('app.post("/api/case-documents"');
 const routeEnd = server.indexOf('app.use\(\(_req, res\) =>', routeStart);
 const routes = server.slice(routeStart, routeEnd);
 assert.equal((routes.match(/finally\{releaseClient\(c\);\}/g) || []).length, 3);
 assert.equal((routes.match(/try\{c=await acquireClient\(pool\)/g) || []).length, 3);
 assert.doesNotMatch(routes, /catch\(error\)\{await c\.query\("rollback"\)/);
});
test("unhandled and oversized request errors return sanitized JSON", () => {
 assert.match(server, /app\.use\(\(error, _req, res, next\) =>/);
 assert.match(server, /error: "request_too_large"/);
 assert.match(server, /error: "invalid_json"/);
 assert.match(server, /error: "internal_server_error"/);
});

test("server error logging records only safe error metadata", () => {
 assert.match(server, /const logSafeError = \(context, error\) =>/);
 assert.match(server, /console\.error\(context, safe\)/);
 assert.doesNotMatch(server, /console\.error\([^\\n]*,\s*error\s*\)/);
 assert.match(transactionHelper, /rollbackError\?\.code/);
 assert.doesNotMatch(transactionHelper, /console\.error\([^\\n]*,\s*rollbackError\s*\)/);
});

test("document migration has office-scoped partial indexes for active-document listing", () => {
 assert.match(migration, /case_documents_office_case_created_idx on case_documents \(office_id, case_id, created_at desc\) where deleted_at is null/);
 assert.match(migration, /case_documents_office_created_idx on case_documents \(office_id, created_at desc\) where deleted_at is null/);
 assert.match(migration, /case_documents_updated_by_same_office_fk/);
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


test("forwarded IP headers are ignored unless proxy trust is explicitly configured", () => {
 assert.match(server, /const trustProxyHops = process\.env\.TRUST_PROXY_HOPS/);
 assert.match(server, /app\.set\("trust proxy", trustProxyHops/);
 assert.doesNotMatch(server, /app\.set\("trust proxy", 1\)/);
});

test("rate limiter expires stale keys and caps per-process key storage", () => {
 assert.match(server, /if \(entry\.resetAt <= now\) clients\.delete\(clientKey\)/);
 assert.match(server, /clients\.size >= 10000/);
});

test("logout revokes server-side session and clears both auth cookies", () => {
 assert.match(server, /app\.post\("\/api\/auth\/logout", requireAuth, requireTrustedOrigin, requireCsrf/);
 assert.match(server, /update auth_sessions set revoked_at = now\(\) where id = \$1 and revoked_at is null/);
 assert.match(server, /setClearAuthCookies\(res\)/);
 assert.match(server, /s\.revoked_at is null/);
 assert.match(server, /s\.expires_at > now\(\)/);
});

test("document creation is idempotent and sensitive endpoints are rate limited", () => {
 assert.match(server, /idempotency-key/);
 assert.match(server, /request_fingerprint/);
 assert.match(server, /on conflict \(office_id,created_by,idempotency_key\)/);
 assert.match(server, /idempotent_replay:\s*true/);
 assert.match(server, /createRateLimiter\(\{ windowMs: 15 \* 60 \* 1000, maxRequests: 5 \}\)/);
 assert.match(server, /createRateLimiter\(\{ windowMs: 15 \* 60 \* 1000, maxRequests: 10 \}\)/);
 assert.match(server, /createRateLimiter\(\{ windowMs: 15 \* 60 \* 1000, maxRequests: 20 \}\)/);
 assert.match(server, /Retry-After/);
 assert.match(server, /Max-Age=28800/);
 assert.match(server, /SameSite=/);
 assert.match(server, /interval '8 hours'/);
 assert.match(server, /s\.expires_at > now\(\)/);
 assert.match(migration, /case_documents_idempotency_unique_idx/);
 assert.match(migration, /request_fingerprint char\(64\)/);
});
