BEGIN;

CREATE TABLE public.lead_submissions (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL UNIQUE,
  consent_id uuid NOT NULL,
  contact jsonb NOT NULL CHECK (jsonb_typeof(contact) = 'object'),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 12000),
  facts_version bigint NOT NULL CHECK (facts_version BETWEEN 0 AND 9007199254740991),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  marker text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'partial', 'unknown', 'failed')),
  stage text NOT NULL DEFAULT 'contact' CHECK (stage IN ('contact', 'note', 'complete')),
  contact_id text CHECK (length(contact_id) > 0),
  note_id text CHECK (length(note_id) > 0),
  safe_error_code text CHECK (safe_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, conversation_id) REFERENCES public.integration_operations(id, conversation_id),
  FOREIGN KEY (consent_id, conversation_id) REFERENCES public.consents(id, conversation_id),
  CHECK (status <> 'saved' OR (contact_id IS NOT NULL AND note_id IS NOT NULL AND stage = 'complete' AND safe_error_code IS NULL)),
  CHECK (status <> 'partial' OR (contact_id IS NOT NULL AND note_id IS NULL))
);

-- One canonical human-inbox request per conversation, including new-key replays.
CREATE UNIQUE INDEX handoff_requests_one_conversation ON public.handoff_requests(conversation_id);
ALTER TABLE public.lead_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lead_submissions FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.lead_submissions FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.lead_submissions TO service_role;
    CREATE POLICY backend_service ON public.lead_submissions TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
