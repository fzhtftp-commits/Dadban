BEGIN;

-- Generic request idempotency for business mutations. This is deliberately
-- separate from case_document_mutation_idempotency (migration 006), whose
-- response contract and operation constraints remain document-specific.
CREATE TABLE public.api_mutation_idempotency (
  office_id uuid NOT NULL,
  user_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  resource_type varchar(32) NOT NULL
    CHECK (resource_type IN ('client','case','hearing','case_action')),
  operation varchar(6) NOT NULL
    CHECK (operation IN ('POST','PATCH','DELETE')),
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  resource_id uuid,
  response_status smallint,
  response_body jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_mutation_idempotency_pkey
    PRIMARY KEY (office_id,user_id,idempotency_key),
  CONSTRAINT api_mutation_idempotency_user_office_fk
    FOREIGN KEY (user_id,office_id)
    REFERENCES public.users(id,office_id) ON DELETE RESTRICT,
  CONSTRAINT api_mutation_idempotency_response_state_check
    CHECK (
      (response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
      OR
      (response_status BETWEEN 200 AND 499 AND response_body IS NOT NULL AND completed_at IS NOT NULL)
    )
);

CREATE INDEX api_mutation_idempotency_created_at_idx
  ON public.api_mutation_idempotency (created_at);

COMMIT;
