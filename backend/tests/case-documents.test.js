import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const migration = await readFile(new URL("../migrations/004_case_documents_metadata.sql", import.meta.url), "utf8");
const sharedRateLimitMigration = await readFile(new URL("../migrations/005_shared_rate_limits.sql", import.meta.url), "utf8");
const mutationIdempotencyMigration = await readFile(new URL("../migrations/006_case_document_mutation_idempotency.sql", import.meta.url), "utf8");
const actorLockMigration = await readFile(new URL("../migrations/008_security_definer_document_actor_lock.sql", import.meta.url), "utf8");
const sharedRateLimiter = await readFile(new URL("../src/shared-rate-limiter.js", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const transactionHelper = await readFile(new URL("../src/document-transaction.js", import.meta.url), "utf8");
test("schema is strictly metadata-only and enforces office-scoped foreign keys", () => {
 assert.match(migration, /storage_status/);
 assert.doesNotMatch(migration, /storage_key/i);
 assert.match(migration, /size_bytes.*26214400/);
 assert.match(migration, /case_documents_case_same_office_fk/);
 assert.match(migration, /case_documents_created_by_same_office_fk/);
});
test("CRUD endpoints require authentication and protect writes", () => {
 assert.match(server, /app\.get\("\/api\/case-documents", requireAuth/);
 assert.match(server, /app\.get\("\/api\/case-documents\/:id", requireAuth/);
 assert.match(server, /app\.post\("\/api\/case-documents", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant"\), requireTrustedOrigin, requireCsrf/);
 assert.match(server, /app\.patch\("\/api\/case-documents\/:id", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant"\), requireTrustedOrigin, requireCsrf/);
 assert.match(server, /app\.delete\("\/api\/case-documents\/:id", requireAuth, requireDocumentRole\("owner", "admin"\), requireTrustedOrigin, requireCsrf/);
 assert.match(server, /d\.office_id = \$1/);
});
test("case-document routes enforce the approved role matrix centrally", () => {
 assert.match(server, /const requireDocumentRole = \(\.\.\.allowedRoles\) =>/);
 assert.match(server, /return res\.status\(403\)\.json\(\{ error: "document_role_forbidden" \}\)/);
 assert.match(server, /app\.get\("\/api\/case-documents", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant", "viewer"\)/);
 assert.match(server, /app\.get\("\/api\/case-documents\/:id", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant", "viewer"\)/);
 assert.match(server, /app\.post\("\/api\/case-documents", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant"\)/);
 assert.match(server, /app\.patch\("\/api\/case-documents\/:id", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant"\)/);
 assert.match(server, /app\.delete\("\/api\/case-documents\/:id", requireAuth, requireDocumentRole\("owner", "admin"\)/);
});

test("PATCH and DELETE idempotency keys are persisted without duplicating document payloads", () => {
 assert.match(mutationIdempotencyMigration, /case_document_mutation_idempotency/);
 assert.match(mutationIdempotencyMigration, /PRIMARY KEY/);
 assert.match(mutationIdempotencyMigration, /request_fingerprint/);
 assert.match(mutationIdempotencyMigration, /response_status/);
 assert.doesNotMatch(mutationIdempotencyMigration, /response_body|original_filename|description/i);
 assert.match(server, /beginDocumentMutationIdempotency/);
 assert.match(server, /completeDocumentMutationIdempotency/);
 assert.match(server, /idempotency_key_reused/);
});

test("document write transactions revalidate and lock the live session and user through the least-privilege definer helper", () => {
 assert.match(server, /const lockLiveDocumentActor = async/);
 assert.match(server, /public\.lock_live_document_actor\(\$1,\$2,\$3\)/);
 assert.match(actorLockMigration, /SECURITY DEFINER/);
 assert.match(actorLockMigration, /FOR UPDATE OF s,u/);
 assert.match(actorLockMigration, /SET search_path = pg_catalog, pg_temp/);
 assert.match(actorLockMigration, /NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/);
 assert.match(actorLockMigration, /s\.expires_at > clock_timestamp\(\)[\s\S]*u\.is_active[\s\S]*u\.deleted_at IS NULL/);
 assert.match(actorLockMigration, /REVOKE ALL ON FUNCTION public\.lock_live_document_actor\(uuid,uuid,uuid\) FROM PUBLIC/);
 assert.match(actorLockMigration, /must not participate in role memberships/);
 assert.doesNotMatch(actorLockMigration, /TO postgres/);
 assert.ok(actorLockMigration.includes("GRANT EXECUTE ON FUNCTION public.lock_live_document_actor(uuid,uuid,uuid) TO dadban_document_runtime_ci"));
 assert.equal((server.match(/lockLiveDocumentActor\(c, req,/g) || []).length, 3, "create, update, and delete must revalidate actor state inside their transactions");
 assert.match(server, /rollbackSucceeded && \["40001", "40P01", "55P03", "57014"\]\.includes\(error\?\.code\)/);
 assert.match(server, /dbError\(error,rollbackSucceeded\)/);
});

test("all client, case, hearing, and action writes revalidate the live actor and writable role in-transaction", () => {
 const routes = [
   'app.post("/api/clients",', 'app.patch("/api/clients/:id",', 'app.delete("/api/clients/:id",',
   'app.post("/api/cases",', 'app.patch("/api/cases/:id",', 'app.delete("/api/cases/:id",',
   'app.post("/api/hearings",', 'app.patch("/api/hearings/:id",', 'app.delete("/api/hearings/:id",',
   'app.post("/api/actions",', 'app.patch("/api/actions/:id",', 'app.delete("/api/actions/:id",'
 ];
 for (const start of routes) {
   const from = server.indexOf(start);
   assert.notEqual(from, -1, `missing write route: ${start}`);
   const next = server.indexOf("\napp.", from + start.length);
   const route = server.slice(from, next < 0 ? server.length : next);
   const begin = route.indexOf('await client.query("begin");');
   const actor = route.indexOf("lockLiveMutationActor(client, req)");
   assert.ok(begin >= 0 && actor > begin, `${start} must revalidate actor after BEGIN and before any business write`);
 }
 assert.match(server, /const lockLiveMutationActor = async/);
 assert.match(server, /\["owner", "admin", "lawyer", "assistant"\]/);
 assert.match(server, /mutation_role_forbidden/);
});
 
test("confidentiality policy is enforced by API and audit", () => {
 assert.match(server, /const canReadCaseDocument = \(role, level\) =>/);
 assert.ok(server.includes("u.role='assistant' and d.confidentiality in ('normal','confidential')"));
 assert.ok(server.includes("u.role='viewer' and d.confidentiality='normal'"));
 assert.match(server, /join users u on u\.id=\$3 and u\.office_id=d\.office_id and u\.is_active=true and u\.deleted_at is null/);
 assert.match(server, /join users u on u\.id=\$2 and u\.office_id=d\.office_id and u\.is_active=true and u\.deleted_at is null/);
 assert.match(server, /!canCreateCaseDocument\(req\.auth\.role,d\.confidentiality\)/);
 assert.match(server, /Object\.hasOwn\(p\.data,"confidentiality"\)&&!canChangeDocumentConfidentiality\(req\.auth\.role\)/);
 assert.match(server, /confidentiality_change=\{from:current\.rows\[0\]\.confidentiality,to:q\.rows\[0\]\.confidentiality\}/);
 assert.match(server, /for update/i);
});
test("metadata phase has no upload handling or storage key", () => {
 assert.doesNotMatch(migration, /storage_key/i);
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
 assert.ok(update.includes('sets.join(",")') && update.includes('where id=$"+(v.length-1)+" and office_id=$"+v.length+"'), "PATCH must bind its generated SQL parameters");
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
 assert.equal((routes.match(/try\{\s*c=await acquireClient\(pool\)/g) || []).length, 3);
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
 assert.match(migration, /create index case_documents_office_case_created_idx/i);
 assert.match(migration, /where deleted_at is null/i);
 assert.match(migration, /create index case_documents_office_created_idx/i);

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
  assert.match(server, /reference_number:.*max\(120\)/);
 assert.match(server, /const originalFilenameSchema = z\.string\(\)\.trim\(\)\.min\(1\)\.max\(255\)/);
 assert.match(server, /original_filename: originalFilenameSchema\.optional\(\)\.nullable\(\)/);
 assert.match(server, /Filename must be a basename without path separators or control characters/);
 assert.match(migration, /storage_status/);
});


test("forwarded IP headers are ignored by default", () => {
 assert.match(server, /app\.set\("trust proxy", false\)/);
});
test("rate limiter expires stale keys and caps per-process key storage", () => {
 assert.match(server, /if \(entry\.resetAt <= now\) clients\.delete\(clientKey\)/);
 assert.match(server, /clients\.size >= 10000/);
});

test("logout revokes server-side session and clears both auth cookies", () => {
 assert.match(server, /app\.post\("\/api\/case-documents", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant"\), requireTrustedOrigin, requireCsrf/);
 assert.match(server, /update auth_sessions set revoked_at = now\(\) where id = \$1 and user_id = \$2 and office_id = \$3 and revoked_at is null returning id/);
 assert.match(server, /setClearAuthCookies\(res\)/);
 assert.match(server, /s\.revoked_at is null/);
 assert.match(server, /s\.expires_at > now\(\)/);
});

test("document creation is idempotent and sensitive endpoints are rate limited", () => {
 assert.match(server, /idempotency-key/);
 assert.match(server, /request_fingerprint/);
 assert.match(server, /on conflict \(office_id,created_by,idempotency_key\)/);
 assert.match(server, /idempotent_replay:\s*true/);
 assert.match(server, /createConfiguredRateLimiter\(\{ bucket: "register", maxRequests: 5 \}\)/);
 assert.match(server, /createConfiguredRateLimiter\(\{ bucket: "login", maxRequests: 10 \}\)/);
 assert.match(server, /createConfiguredRateLimiter\(\{ bucket: "document_create", maxRequests: 20 \}\)/);
 // Keep the shared limiter attached to the intended route, before handlers run.
 assert.match(server, /app\.post\("\/api\/auth\/register", requireTrustedOrigin, registerRateLimit, async \(req, res\) =>/);
 assert.match(server, /app\.post\("\/api\/auth\/login", requireTrustedOrigin, loginRateLimit, async \(req, res\) =>/);
 assert.match(server, /app\.post\("\/api\/case-documents", requireAuth, requireDocumentRole\("owner", "admin", "lawyer", "assistant"\), requireTrustedOrigin, requireCsrf, createDocumentRateLimit, async\(req,res\)=>/);
 assert.match(server, /RATE_LIMIT_MODE=postgres requires RATE_LIMIT_HMAC_KEY/);
 assert.match(server, /RATE_LIMIT_MODE=postgres/);
 assert.match(sharedRateLimiter, /createHmac\("sha256"/);
 assert.match(sharedRateLimiter, /ON CONFLICT \(bucket_name, key_digest, window_start\)/);
 assert.match(sharedRateLimiter, /FOR UPDATE SKIP LOCKED/);
 assert.match(sharedRateLimiter, /rate_limit_unavailable/);
 assert.match(sharedRateLimiter, /CLEANUP_BATCH_SIZE = 500/);
 assert.match(sharedRateLimitMigration, /PRIMARY KEY \(bucket_name, key_digest, window_start\)/);
 assert.match(sharedRateLimitMigration, /octet_length\(key_digest\) = 32/);
 assert.match(sharedRateLimitMigration, /rate_limit_counters_expires_at_idx/);
 assert.match(server, /Retry-After/);
 assert.match(server, /Max-Age=28800/);
 assert.match(server, /SameSite=/);
 assert.match(server, /interval '8 hours'/);
 assert.match(server, /s\.expires_at > now\(\)/);
 assert.match(migration, /case_documents_idempotency_unique_idx/);
 assert.match(migration, /request_fingerprint char\(64\)/);
});


test("migration fails closed instead of silently accepting same-named pre-existing schema objects", () => {
 assert.match(migration, /create table case_documents\s*\(/i);
 assert.doesNotMatch(migration, /create table if not exists case_documents/i);
 assert.match(migration, /create unique index case_documents_idempotency_unique_idx/i);
 assert.match(migration, /create index case_documents_office_case_created_idx/i);
 assert.match(migration, /create index case_documents_office_created_idx/i);
 assert.doesNotMatch(migration, /create (?:unique )?index if not exists case_documents_/i);
});


test("confidentiality contract is consistent across migration, API schema, and UI", async () => {
 const ui = await readFile(new URL("../../documents.html", import.meta.url), "utf8");
 const script = await readFile(new URL("../../documents.js", import.meta.url), "utf8");
 assert.match(migration, /confidentiality varchar\(16\) NOT NULL DEFAULT 'confidential'/);
 assert.match(migration, /confidentiality IN \('normal','confidential','restricted'\)/);
 assert.match(server, /const documentConfidentialitySchema = z\.enum\(\["normal","confidential","restricted"\]\)/);
 assert.match(server, /confidentiality: documentConfidentialitySchema\.default\("confidential"\)/);
 assert.match(server, /confidentiality: documentConfidentialitySchema\.optional\(\)/);
 assert.match(server, /reference_number,d\.confidentiality,d\.storage_status/);
 assert.match(server, /reference_number,confidentiality,idempotency_key,request_fingerprint/);
 assert.match(server, /\["title","document_type","confidentiality","description"/);
 assert.match(ui, /id="confidentiality"/);
 assert.match(script, /confidentialityLabels/);
 assert.match(script, /confidentiality:\$\("confidentiality"\)\.value/);
});
