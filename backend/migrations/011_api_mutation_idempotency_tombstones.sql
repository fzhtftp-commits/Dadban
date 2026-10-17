BEGIN;

-- Keep completed idempotency keys as tombstones after response minimization/purge.
-- No automatic TTL is introduced: retention duration requires an approved policy.
ALTER TABLE public.api_mutation_idempotency
  ADD COLUMN response_body_purged boolean NOT NULL DEFAULT false,
  ADD COLUMN purged_at timestamptz;

ALTER TABLE public.api_mutation_idempotency
  DROP CONSTRAINT api_mutation_idempotency_response_state_check;

ALTER TABLE public.api_mutation_idempotency
  ADD CONSTRAINT api_mutation_idempotency_response_state_check
  CHECK (
    (
      response_status IS NULL
      AND response_body IS NULL
      AND completed_at IS NULL
      AND response_body_purged = false
      AND purged_at IS NULL
    )
    OR
    (
      response_status BETWEEN 200 AND 499
      AND completed_at IS NOT NULL
      AND (
        (
          response_body IS NOT NULL
          AND response_body_purged = false
          AND purged_at IS NULL
        )
        OR
        (
          response_body IS NULL
          AND response_body_purged = true
          AND purged_at IS NOT NULL
        )
      )
    )
  );

COMMIT;
