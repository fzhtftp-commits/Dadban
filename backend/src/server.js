import express from "express";
import cors from "cors";
import helmet from "helmet";
import pg from "pg";
import fs from "node:fs";
import { z } from "zod";

const { Pool } = pg;
const app = express();

const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL;

const caPath = new URL("../certs/prod-ca-2021.crt", import.meta.url);
const supabaseCa = fs.readFileSync(caPath, "utf8");

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl: databaseUrl.includes("localhost")
        ? false
        : {
            ca: supabaseCa,
            rejectUnauthorized: true
          }
    })
  : null;

app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:5500",
    credentials: true
  })
);
app.use(express.json({ limit: "100kb" }));

const normalizeDigits = (value = "") =>
  String(value)
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

const optionalText = z.string().trim().max(5000).optional().nullable();
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .optional()
  .nullable();

const commonClientSchema = {
  mobile: z.string().trim().max(20).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: emailSchema,
  source: z.string().trim().max(80).optional().nullable(),
  address: optionalText,
  notes: optionalText,
  status: z
    .enum(["active", "needs_followup", "inactive"])
    .optional()
    .default("active")
};

const individualClientSchema = z.object({
  client_type: z.literal("individual"),
  full_name: z.string().trim().min(2).max(160),
  national_id: z.string().trim().transform(normalizeDigits).pipe(z.string().regex(/^\d{10}$/)),
  birth_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  occupation: z.string().trim().max(160).optional().nullable(),
  company_name: z.null().optional().default(null),
  national_company_id: z.null().optional().default(null),
  registration_no: z.null().optional().default(null),
  ...commonClientSchema
});

const companyClientSchema = z.object({
  client_type: z.literal("company"),
  company_name: z.string().trim().min(2).max(240),
  national_company_id: z
    .string()
    .trim()
    .transform(normalizeDigits)
    .pipe(z.string().regex(/^\d{10,20}$/)),
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

const clientPatchSchema = z
  .object({
    client_type: z.enum(["individual", "company"]).optional(),
    full_name: z.string().trim().min(2).max(160).optional().nullable(),
    national_id: z
      .string()
      .trim()
      .transform(normalizeDigits)
      .pipe(z.string().regex(/^\d{10}$/))
      .optional()
      .nullable(),
    birth_date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
    occupation: z.string().trim().max(160).optional().nullable(),
    company_name: z.string().trim().min(2).max(240).optional().nullable(),
    national_company_id: z
      .string()
      .trim()
      .transform(normalizeDigits)
      .pipe(z.string().regex(/^\d{10,20}$/))
      .optional()
      .nullable(),
    registration_no: z.string().trim().max(40).optional().nullable(),
    ...commonClientSchema
  })
  .strict();

const parseUuid = z.string().uuid();

const dbError = (error) => {
  if (error?.code === "23505") {
    return {
      status: 409,
      body: { error: "duplicate_client_identifier" }
    };
  }

  if (error?.code === "23503") {
    return {
      status: 409,
      body: { error: "invalid_related_record" }
    };
  }

  return {
    status: 500,
    body: { error: "database_error" }
  };
};

/*
 * Authentication contract:
 * The final login/session/WebAuthn layer will populate req.auth with:
 *   { userId: UUID, officeId: UUID }
 *
 * Do NOT accept userId/officeId from request body or query parameters.
 * Until the authentication layer is connected, Clients API remains locked.
 */
const requireAuth = (req, res, next) => {
  if (!req.auth?.userId || !req.auth?.officeId) {
    return res.status(401).json({
      error: "authentication_required"
    });
  }

  next();
};

const writeAuditLog = async (client, auth, action, entityId, req, metadata = null) => {
  await client.query(
    `
      insert into audit_logs
        (office_id, user_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
      values
        ($1, $2, $3, 'client', $4, $5, $6, $7)
    `,
    [
      auth.officeId,
      auth.userId,
      action,
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
  if (!pool) {
    return res.status(503).json({
      ok: false,
      database: "not_configured"
    });
  }

  try {
    await pool.query("select 1");
    return res.json({
      ok: true,
      database: "connected"
    });
  } catch (error) {
    console.error("Database health check failed:", error);
    return res.status(503).json({
      ok: false,
      database: "unavailable"
    });
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

  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_query",
      details: parsed.error.flatten()
    });
  }

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
        select
          id,
          client_type,
          full_name,
          national_id,
          birth_date,
          occupation,
          company_name,
          national_company_id,
          registration_no,
          mobile,
          phone,
          email,
          source,
          address,
          notes,
          status,
          created_at,
          updated_at
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
      pagination: {
        page,
        limit,
        returned: result.rows.length
      }
    });
  } catch (error) {
    console.error("List clients failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.post("/api/clients", requireAuth, async (req, res) => {
  const parsed = clientCreateSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_client",
      details: parsed.error.flatten()
    });
  }

  const data = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("begin");

    const result = await client.query(
      `
        insert into clients (
          office_id,
          client_type,
          full_name,
          national_id,
          birth_date,
          occupation,
          company_name,
          national_company_id,
          registration_no,
          mobile,
          phone,
          email,
          source,
          address,
          notes,
          status,
          created_by,
          updated_by
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17
        )
        returning *
      `,
      [
        req.auth.officeId,
        data.client_type,
        data.full_name ?? null,
        data.national_id ?? null,
        data.birth_date ?? null,
        data.occupation ?? null,
        data.company_name ?? null,
        data.national_company_id ?? null,
        data.registration_no ?? null,
        data.mobile ?? null,
        data.phone ?? null,
        data.email ? data.email.toLowerCase() : null,
        data.source ?? null,
        data.address ?? null,
        data.notes ?? null,
        data.status,
        req.auth.userId
      ]
    );

    const created = result.rows[0];

    await writeAuditLog(
      client,
      req.auth,
      "create",
      created.id,
      req,
      { client_type: created.client_type }
    );

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

app.get("/api/clients/:id", requireAuth, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);

  if (!id.success) {
    return res.status(400).json({ error: "invalid_client_id" });
  }

  try {
    const result = await pool.query(
      `
        select
          id,
          client_type,
          full_name,
          national_id,
          birth_date,
          occupation,
          company_name,
          national_company_id,
          registration_no,
          mobile,
          phone,
          email,
          source,
          address,
          notes,
          status,
          created_at,
          updated_at
        from clients
        where id = $1
          and office_id = $2
          and deleted_at is null
      `,
      [id.data, req.auth.officeId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "client_not_found" });
    }

    return res.json({ data: result.rows[0] });
  } catch (error) {
    console.error("Get client failed:", error);
    const failure = dbError(error);
    return res.status(failure.status).json(failure.body);
  }
});

app.patch("/api/clients/:id", requireAuth, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);

  if (!id.success) {
    return res.status(400).json({ error: "invalid_client_id" });
  }

  const parsed = clientPatchSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "invalid_client_update",
      details: parsed.error.flatten()
    });
  }

  const data = parsed.data;
  const allowedFields = [
    "client_type",
    "full_name",
    "national_id",
    "birth_date",
    "occupation",
    "company_name",
    "national_company_id",
    "registration_no",
    "mobile",
    "phone",
    "email",
    "source",
    "address",
    "notes",
    "status"
  ];

  const fields = [];
  const values = [id.data, req.auth.officeId];

  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      const value =
        field === "email" && data[field]
          ? data[field].toLowerCase()
          : data[field];

      values.push(value ?? null);
      fields.push(`${field} = $${values.length}`);
    }
  }

  if (!fields.length) {
    return res.status(400).json({ error: "no_changes" });
  }

  values.push(req.auth.userId);
  fields.push(`updated_by = $${values.length}`);

  const client = await pool.connect();

  try {
    await client.query("begin");

    const result = await client.query(
      `
        update clients
        set ${fields.join(", ")}
        where id = $1
          and office_id = $2
          and deleted_at is null
        returning *
      `,
      values
    );

    if (!result.rowCount) {
      await client.query("rollback");
      return res.status(404).json({ error: "client_not_found" });
    }

    const updated = result.rows[0];

    await writeAuditLog(
      client,
      req.auth,
      "update",
      updated.id,
      req,
      { fields: Object.keys(data) }
    );

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

app.delete("/api/clients/:id", requireAuth, async (req, res) => {
  const id = parseUuid.safeParse(req.params.id);

  if (!id.success) {
    return res.status(400).json({ error: "invalid_client_id" });
  }

  const client = await pool.connect();

  try {
    await client.query("begin");

    const result = await client.query(
      `
        update clients
        set
          deleted_at = now(),
          updated_by = $3
        where id = $1
          and office_id = $2
          and deleted_at is null
        returning id
      `,
      [id.data, req.auth.officeId, req.auth.userId]
    );

    if (!result.rowCount) {
      await client.query("rollback");
      return res.status(404).json({ error: "client_not_found" });
    }

    await writeAuditLog(
      client,
      req.auth,
      "delete",
      result.rows[0].id,
      req
    );

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

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

const host = "0.0.0.0";

app.listen(port, host, () => {
  console.log(`Dadban API listening on ${host}:${port}`);
});
