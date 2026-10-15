BEGIN;

-- Dedicated mutable counter storage; never reuse append-only audit_logs.
-- Apply manually with the reviewed production database role before enabling
-- RATE_LIMIT_MODE=postgres. Do not run this migration at application startup.
CREATE TABLE public.rate_limit_counters (
  bucket_name text NOT NULL
    CHECK (bucket_name IN ('register', 'login', 'document_create')),
  key_digest bytea NOT NULL
    CHECK (octet_length(key_digest) = 32),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 1
    CHECK (request_count > 0),
  expires_at timestamptz NOT NULL
    CHECK (expires_at > window_start),
  CONSTRAINT rate_limit_counters_pkey
    PRIMARY KEY (bucket_name, key_digest, window_start)
);

CREATE INDEX rate_limit_counters_expires_at_idx
  ON public.rate_limit_counters (expires_at);

COMMIT;
