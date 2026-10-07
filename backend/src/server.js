import express from "express";
import cors from "cors";
import helmet from "helmet";
import pg from "pg";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 10000);
const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 10,
      ssl: databaseUrl.includes("localhost")
        ? false
        : { rejectUnauthorized: true }
    })
  : null;

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:5500",
  credentials: true
}));
app.use(express.json({ limit: "100kb" }));

// Liveness endpoint: must stay independent from the database so Render
// can route traffic even if the external database is temporarily unavailable.
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "dadban-backend" });
});

// Database readiness endpoint: temporarily exposes only safe PostgreSQL
// diagnostics. Never returns DATABASE_URL, password, host, or connection string.
app.get("/health/db", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      database: "not_configured"
    });
  }

  try {
    const result = await pool.query("select 1 as ok");
    return res.json({
      ok: true,
      database: "connected",
      result: result.rows[0]
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    return res.status(503).json({
      ok: false,
      database: "unavailable",
      error: error?.code || "unknown_database_error",
      message: error?.message || "database connection failed"
    });
  }
});

// Authentication is intentionally required before business APIs.
// This endpoint is a safe placeholder until the final auth architecture
// (session/WebAuthn/device binding) is implemented.
const requireAuth = (_req, res) => {
  return res.status(401).json({
    error: "authentication_required"
  });
};

app.get("/api/clients", requireAuth);
app.post("/api/clients", requireAuth);
app.get("/api/clients/:id", requireAuth);
app.patch("/api/clients/:id", requireAuth);
app.delete("/api/clients/:id", requireAuth);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

const host = "0.0.0.0";

app.listen(port, host, () => {
  console.log(`Dadban API listening on ${host}:${port}`);
});
