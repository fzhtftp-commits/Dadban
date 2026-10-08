import express from "express";
import cors from "cors";
import helmet from "helmet";
import pg from "pg";
import fs from "node:fs";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const { Pool } = pg;
const scrypt = promisify(crypto.scrypt);
const app = express();

const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === "production";
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5500";

const caPath = new URL("../certs/prod-ca-2021.crt", import.meta.url);
const supabaseCa = fs.readFileSync(caPath, "utf8");

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl: databaseUrl.includes("localhost")
        ? false
        : { ca: supabaseCa, rejectUnauthorized: true }
    })
  : null;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "100kb" }));

const normalizeDigits = (value = "") =>
  String(value)
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

const optionalText = z.string().trim().max(5000).optional().nullable();
const emailSchema = z.string().trim().email().max(320).transform((v) => v.toLowerCase());

const commonClientSchema = {
  mobile: z.string().trim().max(20).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().max(320).optional().nullable(),
  source: z.string().trim().max(80).optional().nullable(),
  address: optionalText,
  notes: optionalText,
  status: z.enum(["active", "needs_followup", "inactive"]).optional().default("active")
};

const individualClientSchema = z.object({
  client_type: z.literal("individual"),
  full_name: z.string().trim().min(2).max(160),
  national_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10}$/)),
  birth_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  occupation: z.string().trim().max(160).optional().nullable(),
  company_name: z.null().optional().default(null),
  national_company_id: z.null().optional().default(null),
  registration_no: z.null().optional().default(null),
  ...commonClientSchema
});

const companyClientSchema = z.object({
  client_type: z.literal("company"),
  company_name: z.string().trim().min(2).max(240),
  national_company_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10,20}$/)),
  registration_no: z.string().trim().max(40).optional().nullable(),
  full_name: z.null().optional().default(null),
  national_id: z.null().optional().default(null),
  birth_date: z.null().optional().default(null),
  occupation: z.null().optional().default(null),
  ...commonClientSchema
});

const clientCreateSchema = z.discriminatedUnion("client_type", [
  individualClientSchema,
  companyClientSchema
]);

const clientPatchSchema = z.object({
  client_type: z.enum(["individual", "company"]).optional(),
  full_name: z.string().trim().min(2).max(160).optional().nullable(),
  national_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10}$/)).optional().nullable(),
  birth_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  occupation: z.string().trim().max(160).optional().nullable(),
  company_name: z.string().trim().min(2).max(240).optional().nullable(),
  national_company_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10,20}$/)).optional().nullable(),
  registration_no: z.string().trim().max(40).optional().nullable(),
  mobile: z.string().trim().max(20).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().email().max(320).optional().nullable(),
  source: z.string().trim().max(80).optional().nullable(),
  address: optionalText,
  notes: optionalText,
  status: z.enum(["active", "needs_followup", "inactive"]).optional()
}).strict();

const caseCreateSchema = z.object({
  client_id: z.string().uuid(),
  case_number: z.string().trim().min(1).max(80),
  title: z.string().trim().min(2).max(240),
  case_type: z.string().trim().max(80).optional().nullable(),
  court_name: z.string().trim().max(200).optional().nullable(),
  branch_name: z.string().trim().max(120).optional().nullable(),
  opposing_party: z.string().trim().max(240).optional().nullable(),
  status: z.enum(["active","pending","closed","archived"]).optional().default("active"),
  priority: z.enum(["low","normal","high","urgent"]).optional().default("normal"),
  filing_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  next_hearing_at: z.string().datetime({ offset: true }).optional().nullable(),
  description: optionalText,
  notes: optionalText
});

const casePatchSchema = caseCreateSchema.partial().strict();

const registerSchema = z.object({
  full_name: z.string().trim().min(2).max(160),
  email: emailSchema,
  password: z.string().min(12).max(128),
  office_name: z.string().trim().min(2).max(200)
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128)
});

const parseUuid = z.string().uuid();

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const parseCookies = (header = "") =>
  Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return ["", ""];
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      try {
        return [key, decodeURIComponent(value)];
      } catch {
        return [key, value];
      }
    }).filter(([key]) => key)
  );

const cookieOptions = (httpOnly) => {
  const options = [
    "Path=/",
    "Max-Age=28800",
    "SameSite=" + (isProduction ? "None" : "Lax")
  ];
  if (isProduction) options.push("Secure");
  if (httpOnly) options.push("HttpOnly");
  return options.join("; ");
};

const clearCookie = (name) => {
  const options = ["Path=/", "Max-Age=0", "SameSite=" + (isProduction ? "None" : "Lax")];
  if (isProduction) options.push("Secure");
  options.push("HttpOnly");
  return `${name}=; ${options.join("; ")}`;
};

const setAuthCookies = (res, sessionToken, csrfToken) => {
  res.setHeader("Set-Cookie", [
    `dadban_session=${encodeURIComponent(sessionToken)}; ${cookieOptions(true)}`,
    `dadban_csrf=${encodeURIComponent(csrfToken)}; ${cookieOptions(false)}`
  ]);
};

const setClearAuthCookies = (res) => {
  res.setHeader("Set-Cookie", [
    clearCookie("dadban_session"),
    clearCookie("dadban_csrf")
  ]);
};

const createPasswordHash = async (password) => {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
};

const verifyPassword = async (password, stored) => {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltText, hashText] = parts;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  const derived = Buffer.from(await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 32 * 1024 * 1024
  }));

  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
};

const dbError = (error) => {
  if (error?.code === "23505") return { status: 409, body: { error: "duplicate_record" } };
  if (error?.code === "23503") return { status: 409, body: { error: "invalid_related_record" } };
  return { status: 500, body: { error: "database_error" } };
};

const requireTrustedOrigin = (req, res, next) => {
  const origin = req.get("origin");
  if (origin && origin !== corsOrigin) {
    return res.status(403).json({ error: "origin_not_allowed" });
  }
  next();
};

const requireAuth = async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.dadban_session;

    if (!token || token.length < 40 || !pool) {
      return res.status(401).json({ error: "authentication_required" });
    }

    const result = await pool.query(
      `
        select s.id as session_id, s.user_id, s.office_id, s.csrf_hash,
               u.full_name, u.email, u.role
        from auth_sessions s
        join users u on u.id = s.user_id
        where s.token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
          and u.is_active = true
          and u.deleted_at is null
      `,
      [hashToken(token)]
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: "authentication_required" });
    }

    req.auth = {
      sessionId: result.rows[0].session_id,
      userId: result.rows[0].user_id,
      officeId: result.rows[0].office_id,
      csrfHash: result.rows[0].csrf_hash,
      fullName: result.rows[0].full_name,
      email: result.rows[0].email,
      role: result.rows[0].role
    };

    await pool.query("update auth_sessions set last_seen_at = now() where id = $1", [req.auth.sessionId]);
    next();
  } catch (error) {
    console.error("Authentication failed:", error);
    return res.status(401).json({ error: "authentication_required" });
  }
};

const requireCsrf = (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const header = req.get("x-csrf-token");
  if (!header || !cookies.dadban_csrf || header !== cookies.dadban_csrf) {
    return res.status(403).json({ error: "csrf_token_required" });
  }
  if (hashToken(header) !== req.auth.csrfHash) {
    return res.status(403).json({ error: "csrf_token_invalid" });
  }
  next();
};

const writeAuditLog = async (client, auth, action, entityType, entityId, req, metadata = null) => {
  await client.query(
    `
      insert into audit_logs
        (office_id, user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
    [
      auth.officeId,
      auth.userId,
      action,
      entityType,
      entityId,
      metadata ? JSON.stringify(metadata) : null,
      req.ip || null,
      req.get("user-agent") || null
    ]
  );
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "dadban-backend" });
});

app.get("/health/db", async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false, database: "not_configured" });
  try {
    await pool.query("select 1");
    return res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("Database health check failed:", error);
    return res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.post("/api/auth/register", requireTrustedOrigin, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_registration" });
  }

  const { full_name, email, password, office_name } = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("begin");
    const office = await client.query(
      "insert into offices (name) values ($1) returning id",
      [office_name]
    );

    const user = await client.query(
      `
        insert into users (office_id, full_name, email, role)
        values ($1,$2,$3,'owner')
        returning id, office_id, full_name, email, role
      `,
      [office.rows[0].id, full_name, email]
    );

    const passwordHash = await createPasswordHash(password);
    await client.query(
      "insert into auth_credentials (user_id, password_hash) values ($1,$2)",
      [user.rows[0].id, passwordHash]
    );

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    await client.query(
      `
        insert into auth_sessions
          (user_id, office_id, token_hash, csrf_hash, expires_at)
        values ($1,$2,$3,$4,now()+interval '8 hours')
      `,
      [user.rows[0].id, user.rows[0].office_id, hashToken(sessionToken), hashToken(csrfToken)]
    );

    await client.query("commit");
    setAuthCookies(res, sessionToken, csrfToken);

    return res.status(201).json({
      data: {
        user: user.rows[0],
        csrf_token: csrfToken
      }
    });
  } catch (error) {
    await client.query("rollback");
    console.error("Registration failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", requireTrustedOrigin, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_login" });

  const { email, password } = parsed.data;

  try {
    const result = await pool.query(
      `
        select u.id, u.office_id, u.full_name, u.email, u.role, c.password_hash
        from users u
        join auth_credentials c on c.user_id = u.id
        where lower(u.email) = lower($1)
          and u.is_active = true
          and u.deleted_at is null
        limit 1
      `,
      [email]
    );

    if (!result.rowCount || !(await verifyPassword(password, result.rows[0].password_hash))) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");

    await pool.query(
      `
        insert into auth_sessions
          (user_id, office_id, token_hash, csrf_hash, expires_at)
        values ($1,$2,$3,$4,now()+interval '8 hours')
      `,
      [
        result.rows[0].id,
        result.rows[0].office_id,
        hashToken(sessionToken),
        hashToken(csrfToken)
      ]
    );

    setAuthCookies(res, sessionToken, csrfToken);

    return res.json({
      data: {
        user: {
          id: result.rows[0].id,
          office_id: result.rows[0].office_id,
          full_name: result.rows[0].full_name,
          email: result.rows[0].email,
          role: result.rows[0].role
        },
        csrf_token: csrfToken
      }
    });
  } catch (error) {
    console.error("Login failed:", error);
    return res.status(500).json({ error: "authentication_error" });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  res.json({
    data: {
      user: {
        id: req.auth.userId,
        office_id: req.auth.officeId,
        full_name: req.auth.fullName,
        email: req.auth.email,
        role: req.auth.role
      }
    }
  });
});

app.post("/api/auth/logout", requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  await pool.query(
    "update auth_sessions set revoked_at = now() where id = $1 and revoked_at is null",
    [req.auth.sessionId]
  );
  setClearAuthCookies(res);
  return res.json({ ok: true });
});


app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const [stats, recentCases, upcomingHearings] = await Promise.all([
      pool.query(
        `
          select
            (select count(*)::int from clients
              where office_id = $1 and deleted_at is null) as total_clients,
            (select count(*)::int from cases
              where office_id = $1 and deleted_at is null and status = 'active') as active_cases,
            (select count(*)::int from cases
              where office_id = $1 and deleted_at is null and status = 'closed') as closed_cases,
            (select count(*)::int from cases
              where office_id = $1 and deleted_at is null
                and next_hearing_at is not null
                and next_hearing_at >= now()) as upcoming_hearings
        `,
        [req.auth.officeId]
      ),
      pool.query(
        `
          select c.id, c.case_number, c.title, c.case_type, c.status,
                 cl.full_name as client_full_name,
                 cl.company_name as client_company_name
          from cases c
          join clients cl on cl.id = c.client_id
            and cl.office_id = c.office_id
            and cl.deleted_at is null
          where c.office_id = $1
            and c.deleted_at is null
          order by c.created_at desc
          limit 5
        `,
        [req.auth.officeId]
      ),
      pool.query(
        `
          select c.id, c.case_number, c.title, c.next_hearing_at,
                 c.court_name, c.branch_name,
                 cl.full_name as client_full_name,
                 cl.company_name as client_company_name
          from cases c
          join clients cl on cl.id = c.client_id
            and cl.office_id = c.office_id
            and cl.deleted_at is null
          where c.office_id = $1
            and c.deleted_at is null
            and c.next_hearing_at is not null
            and c.next_hearing_at >= now()
          order by c.next_hearing_at asc
          limit 5
        `,
        [req.auth.officeId]
      )
    ]);

    return res.json({
      data: {
        stats: stats.rows[0] || {
          total_clients: 0,
          active_cases: 0,
          closed_cases: 0,
          upcoming_hearings: 0
        },
        recent_cases: recentCases.rows,
        upcoming_hearings: upcomingHearings.rows
      }
    });
  } catch (error) {
    console.error("Dashboard data failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.get("/api/clients", requireAuth, async (req, res) => {
  const querySchema = z.object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(["active", "needs_followup", "inactive"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });

  const { search, status, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const values = [req.auth.officeId];
  const conditions = ["c.office_id = $1", "c.deleted_at is null"];

  if (status) {
    values.push(status);
    conditions.push(`c.status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(
      c.full_name ilike $${values.length}
      or c.company_name ilike $${values.length}
      or c.national_id ilike $${values.length}
      or c.national_company_id ilike $${values.length}
      or c.mobile ilike $${values.length}
      or c.email ilike $${values.length}
    )`);
  }

  values.push(limit, offset);

  try {
    const result = await pool.query(
      `
        select id, client_type, full_name, national_id, birth_date, occupation,
               company_name, national_company_id, registration_no, mobile, phone,
               email, source, address, notes, status, created_at, updated_at
        from clients c
        where ${conditions.join(" and ")}
        order by c.created_at desc
        limit $${values.length - 1}
        offset $${values.length}
      `,
      values
    );

    return res.json({
      data: result.rows,
      pagination: { page, limit, returned: result.rows.length }
    });
  } catch (error) {
    console.error("List clients failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.post("/api/clients", requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const parsed = clientCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_client" });

  const data = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await client.query(
      `
        insert into clients (
          office_id, client_type, full_name, national_id, birth_date, occupation,
          company_name, national_company_id, registration_no, mobile, phone, email,
          source, address, notes, status, created_by, updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
        returning *
      `,
      [
        req.auth.officeId, data.client_type, data.full_name ?? null, data.national_id ?? null,
        data.birth_date ?? null, data.occupation ?? null, data.company_name ?? null,
        data.national_company_id ?? null, data.registration_no ?? null, data.mobile ?? null,
        data.phone ?? null, data.email ? data.email.toLowerCase() : null, data.source ?? null,
        data.address ?? null, data.notes ?? null, data.status, req.auth.userId
      ]
    );

    const created = result.rows[0];
    await writeAuditLog(client, req.auth, "create", "client", created.id, req, { client_type: created.client_type });
    await client.query("commit");
    return res.status(201).json({ data: created });
  } catch (error) {
    await client.query("rollback");
    console.error("Create client failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  } finally {
    client.release();
  }
});

app.get("/api/clients/lookup", requireAuth, async (req, res) => {
  const parsed = z.object({
    national_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10}$/))
  }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_national_id" });

  try {
    const result = await pool.query(
      `
        select id, client_type, full_name, national_id, company_name, national_company_id, status
        from clients
        where office_id = $1
          and deleted_at is null
          and national_id = $2
        limit 1
      `,
      [req.auth.officeId, parsed.data.national_id]
    );
    if (!result.rowCount) return res.status(404).json({ error: "client_not_found" });
    return res.json({ data: result.rows[0] });
  } catch (error) {
    console.error("Lookup client failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.get("/api/clients/:id", requireAuth, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "invalid_client_id" });

  try {
    const result = await pool.query(
      `
        select id, client_type, full_name, national_id, birth_date, occupation,
               company_name, national_company_id, registration_no, mobile, phone,
               email, source, address, notes, status, created_at, updated_at
        from clients
        where id = $1 and office_id = $2 and deleted_at is null
      `,
      [id.data, req.auth.officeId]
    );

    if (!result.rowCount) return res.status(404).json({ error: "client_not_found" });
    return res.json({ data: result.rows[0] });
  } catch (error) {
    console.error("Get client failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.patch("/api/clients/:id", requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "invalid_client_id" });

  const parsed = clientPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_client_update" });

  const data = parsed.data;
  const allowedFields = [
    "client_type","full_name","national_id","birth_date","occupation","company_name",
    "national_company_id","registration_no","mobile","phone","email","source","address","notes","status"
  ];
  const fields = [];
  const values = [id.data, req.auth.officeId];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      const value = field === "email" && data[field] ? data[field].toLowerCase() : data[field];
      values.push(value ?? null);
      fields.push(`${field} = $${values.length}`);
    }
  }

  if (!fields.length) return res.status(400).json({ error: "no_changes" });

  values.push(req.auth.userId);
  fields.push(`updated_by = $${values.length}`);

  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await client.query(
      `
        update clients
        set ${fields.join(", ")}
        where id = $1 and office_id = $2 and deleted_at is null
        returning *
      `,
      values
    );

    if (!result.rowCount) {
      await client.query("rollback");
      return res.status(404).json({ error: "client_not_found" });
    }

    const updated = result.rows[0];
    await writeAuditLog(client, req.auth, "update", "client", updated.id, req, { fields: Object.keys(data) });
    await client.query("commit");
    return res.json({ data: updated });
  } catch (error) {
    await client.query("rollback");
    console.error("Update client failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  } finally {
    client.release();
  }
});

app.delete("/api/clients/:id", requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "invalid_client_id" });

  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await client.query(
      `
        update clients
        set deleted_at = now(), updated_by = $3
        where id = $1 and office_id = $2 and deleted_at is null
        returning id
      `,
      [id.data, req.auth.officeId, req.auth.userId]
    );

    if (!result.rowCount) {
      await client.query("rollback");
      return res.status(404).json({ error: "client_not_found" });
    }

    await writeAuditLog(client, req.auth, "delete", "client", result.rows[0].id, req);
    await client.query("commit");
    return res.status(204).send();
  } catch (error) {
    await client.query("rollback");
    console.error("Delete client failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  } finally {
    client.release();
  }
});


app.get("/api/cases", requireAuth, async (req, res) => {
  const querySchema = z.object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(["active","pending","closed","archived"]).optional(),
    client_id: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  });

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid_query" });

  const { search, status, client_id, page, limit } = parsed.data;
  const offset = (page - 1) * limit;
  const values = [req.auth.officeId];
  const conditions = ["c.office_id = $1", "c.deleted_at is null"];

  if (status) {
    values.push(status);
    conditions.push(`c.status = $${values.length}`);
  }
  if (client_id) {
    values.push(client_id);
    conditions.push(`c.client_id = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(
      c.case_number ilike $${values.length}
      or c.title ilike $${values.length}
      or c.case_type ilike $${values.length}
      or c.court_name ilike $${values.length}
      or c.opposing_party ilike $${values.length}
      or cl.full_name ilike $${values.length}
      or cl.company_name ilike $${values.length}
    )`);
  }

  values.push(limit, offset);

  try {
    const result = await pool.query(
      `
        select c.id, c.client_id, c.case_number, c.title, c.case_type,
               c.court_name, c.branch_name, c.opposing_party, c.status,
               c.priority, c.filing_date, c.next_hearing_at, c.description,
               c.notes, c.created_at, c.updated_at,
               cl.client_type, cl.full_name as client_full_name,
               cl.company_name as client_company_name
        from cases c
        join clients cl on cl.id = c.client_id
          and cl.office_id = c.office_id
          and cl.deleted_at is null
        where ${conditions.join(" and ")}
        order by c.created_at desc
        limit $${values.length - 1}
        offset $${values.length}
      `,
      values
    );
    return res.json({ data: result.rows, pagination: { page, limit, returned: result.rows.length } });
  } catch (error) {
    console.error("List cases failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.post("/api/cases", requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const parsed = caseCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_case" });

  const data = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("begin");

    const owner = await client.query(
      "select id from clients where id = $1 and office_id = $2 and deleted_at is null",
      [data.client_id, req.auth.officeId]
    );
    if (!owner.rowCount) {
      await client.query("rollback");
      return res.status(400).json({ error: "invalid_related_client" });
    }

    const result = await client.query(
      `
        insert into cases (
          office_id, client_id, case_number, title, case_type, court_name,
          branch_name, opposing_party, status, priority, filing_date,
          next_hearing_at, description, notes, created_by, updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
        returning *
      `,
      [
        req.auth.officeId, data.client_id, data.case_number, data.title,
        data.case_type ?? null, data.court_name ?? null, data.branch_name ?? null,
        data.opposing_party ?? null, data.status, data.priority,
        data.filing_date ?? null, data.next_hearing_at ?? null,
        data.description ?? null, data.notes ?? null, req.auth.userId
      ]
    );

    const created = result.rows[0];
    await writeAuditLog(client, req.auth, "create", "case", created.id, req, {
      client_id: created.client_id,
      case_number: created.case_number
    });
    await client.query("commit");
    return res.status(201).json({ data: created });
  } catch (error) {
    await client.query("rollback");
    console.error("Create case failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  } finally {
    client.release();
  }
});

app.get("/api/cases/:id", requireAuth, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "invalid_case_id" });

  try {
    const result = await pool.query(
      `
        select c.id, c.client_id, c.case_number, c.title, c.case_type,
               c.court_name, c.branch_name, c.opposing_party, c.status,
               c.priority, c.filing_date, c.next_hearing_at, c.description,
               c.notes, c.created_at, c.updated_at,
               cl.client_type, cl.full_name as client_full_name,
               cl.company_name as client_company_name
        from cases c
        join clients cl on cl.id = c.client_id
          and cl.office_id = c.office_id
          and cl.deleted_at is null
        where c.id = $1 and c.office_id = $2 and c.deleted_at is null
      `,
      [id.data, req.auth.officeId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "case_not_found" });
    return res.json({ data: result.rows[0] });
  } catch (error) {
    console.error("Get case failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.patch("/api/cases/:id", requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "invalid_case_id" });

  const parsed = casePatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_case_update" });

  const data = parsed.data;
  const allowedFields = [
    "client_id","case_number","title","case_type","court_name","branch_name",
    "opposing_party","status","priority","filing_date","next_hearing_at",
    "description","notes"
  ];
  const fields = [];
  const values = [id.data, req.auth.officeId];

  if (Object.prototype.hasOwnProperty.call(data, "client_id")) {
    const owner = await pool.query(
      "select id from clients where id = $1 and office_id = $2 and deleted_at is null",
      [data.client_id, req.auth.officeId]
    );
    if (!owner.rowCount) return res.status(400).json({ error: "invalid_related_client" });
  }

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      values.push(data[field] ?? null);
      fields.push(`${field} = $${values.length}`);
    }
  }

  if (!fields.length) return res.status(400).json({ error: "no_changes" });
  values.push(req.auth.userId);
  fields.push(`updated_by = $${values.length}`);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `
        update cases
        set ${fields.join(", ")}
        where id = $1 and office_id = $2 and deleted_at is null
        returning *
      `,
      values
    );
    if (!result.rowCount) {
      await client.query("rollback");
      return res.status(404).json({ error: "case_not_found" });
    }
    const updated = result.rows[0];
    await writeAuditLog(client, req.auth, "update", "case", updated.id, req, { fields: Object.keys(data) });
    await client.query("commit");
    return res.json({ data: updated });
  } catch (error) {
    await client.query("rollback");
    console.error("Update case failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  } finally {
    client.release();
  }
});

app.delete("/api/cases/:id", requireAuth, requireTrustedOrigin, requireCsrf, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: "invalid_case_id" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `
        update cases
        set deleted_at = now(), updated_by = $3
        where id = $1 and office_id = $2 and deleted_at is null
        returning id
      `,
      [id.data, req.auth.officeId, req.auth.userId]
    );
    if (!result.rowCount) {
      await client.query("rollback");
      return res.status(404).json({ error: "case_not_found" });
    }
    await writeAuditLog(client, req.auth, "delete", "case", result.rows[0].id, req);
    await client.query("commit");
    return res.status(204).send();
  } catch (error) {
    await client.query("rollback");
    console.error("Delete case failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  } finally {
    client.release();
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Dadban API listening on 0.0.0.0:${port}`);
});
