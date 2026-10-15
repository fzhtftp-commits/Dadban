BEGIN;

-- Persist mutation keys separately from append-only audit_logs. Store no document
-- payload or response body; the API re-reads PATCH replay data through current access policy.
CREATE TABLE public.case_document_mutation_idempotency (
  office_id uuid NOT NULL,
  user_id uuid NOT NULL,
  idempotency_key varchar(128) NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  operation varchar(6) NOT NULL
    CHECK (operation IN ('PATCH','DELETE')),
  entity_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- NULL is only an in-transaction reservation; application code sets this
  -- before commit, together with the document mutation and audit row.
  response_status smallint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_document_mutation_idempotency_pkey
    PRIMARY KEY (office_id,user_id,idempotency_key),
  CONSTRAINT case_document_mutation_idempotency_user_office_fk
    FOREIGN KEY (user_id,office_id) REFERENCES public.users(id,office_id) ON DELETE RESTRICT,
  CONSTRAINT case_document_mutation_idempotency_status_check
    CHECK (
      response_status IS NULL OR
      (operation='PATCH' AND response_status=200) OR
      (operation='DELETE' AND response_status=204)
    )
);

COMMIT;
