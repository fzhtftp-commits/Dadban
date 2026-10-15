import crypto from "node:crypto";
import net from "node:net";

const WINDOW_SECONDS = 900;
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_INTERVAL_MS = 60_000;

const safeLog = (error) => {
  const details = {};
  if (typeof error?.name === "string") details.name = error.name.slice(0, 80);
  if (typeof error?.code === "string") details.code = error.code.slice(0, 40);
  console.error("Shared rate limiter unavailable", details);
};

export const createPostgresRateLimiter = (
  pool,
  { secret, bucket, maxRequests, cleanupIntervalMs = CLEANUP_INTERVAL_MS }
) => {
  if (!pool || typeof pool.query !== "function") throw new Error("Shared rate limiter requires PostgreSQL");
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("RATE_LIMIT_HMAC_KEY must contain at least 32 bytes");
  }
  if (!["register", "login", "document_create"].includes(bucket)) {
    throw new Error("Unknown rate-limit bucket");
  }
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("Invalid rate-limit maximum");
  }

  const key = Buffer.from(secret, "utf8");
  let lastCleanupAt = 0;
  let cleanupInFlight = null;

  const cleanupExpired = async () => {
    const now = Date.now();
    if (now - lastCleanupAt < cleanupIntervalMs) return;
    if (cleanupInFlight) return cleanupInFlight;
    lastCleanupAt = now;
    cleanupInFlight = pool.query(`
      WITH expired AS (
        SELECT ctid
        FROM public.rate_limit_counters
        WHERE expires_at <= clock_timestamp()
        ORDER BY expires_at
        LIMIT ${CLEANUP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM public.rate_limit_counters AS counters
      USING expired
      WHERE counters.ctid = expired.ctid
    `).catch((error) => {
      // Cleanup is best-effort; the counter decision itself remains authoritative.
      safeLog(error);
    }).finally(() => {
      cleanupInFlight = null;
    });
    return cleanupInFlight;
  };

  return async (req, res, next) => {
    try {
      const address = req.ip || req.socket?.remoteAddress;
      if (typeof address !== "string" || net.isIP(address) === 0) {
        return res.status(503).json({ error: "rate_limit_unavailable" });
      }

      // PostgreSQL's inet parser canonicalizes IPv6 spellings. The address is
      // used only transiently and is never written to the counter table.
      const canonicalResult = await pool.query(
        "SELECT host($1::inet) AS canonical_ip",
        [address]
      );
      const canonicalIp = canonicalResult.rows?.[0]?.canonical_ip;
      if (typeof canonicalIp !== "string" || !canonicalIp) {
        return res.status(503).json({ error: "rate_limit_unavailable" });
      }

      const digest = crypto.createHmac("sha256", key)
        .update("dadban-rate-limit:v1:")
        .update(bucket)
        .update(":")
        .update(canonicalIp)
        .digest();

      // Window alignment and expiry are derived from one DB-side clock value.
      // The UPSERT is the single serialization point for concurrent instances.
      const result = await pool.query(`
        WITH clock AS (
          SELECT to_timestamp(
            floor(extract(epoch FROM clock_timestamp()) / ${WINDOW_SECONDS}) * ${WINDOW_SECONDS}
          ) AS window_start
        )
        INSERT INTO public.rate_limit_counters
          (bucket_name, key_digest, window_start, request_count, expires_at)
        SELECT $1, $2, clock.window_start, 1,
               clock.window_start + interval '${WINDOW_SECONDS} seconds'
        FROM clock
        ON CONFLICT (bucket_name, key_digest, window_start)
        DO UPDATE SET request_count = public.rate_limit_counters.request_count + 1
        RETURNING request_count, window_start, expires_at,
          GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))))::integer AS retry_after_seconds
      `, [bucket, digest]);

      const row = result.rows?.[0];
      if (!row || !Number.isInteger(Number(row.request_count))) {
        return res.status(503).json({ error: "rate_limit_unavailable" });
      }

      const count = Number(row.request_count);
      res.setHeader("RateLimit-Limit", String(maxRequests));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, maxRequests - count)));
      if (count > maxRequests) {
        res.setHeader("Retry-After", String(Math.max(1, Number(row.retry_after_seconds) || 1)));
        return res.status(429).json({ error: "rate_limit_exceeded" });
      }

      void cleanupExpired();
      return next();
    } catch (error) {
      safeLog(error);
      // Never turn an infrastructure failure into a misleading 429 or fall back
      // to an independent in-process map when shared mode was explicitly selected.
      return res.status(503).json({ error: "rate_limit_unavailable" });
    }
  };
};
