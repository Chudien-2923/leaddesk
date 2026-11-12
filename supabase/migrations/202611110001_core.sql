BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state) = 'object'),
  facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facts) = 'object'),
  facts_version bigint NOT NULL DEFAULT 0 CHECK (facts_version BETWEEN 0 AND 9007199254740991),
  policy_version text CHECK (length(policy_version) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('crm', 'handoff', 'booking')),
  granted boolean NOT NULL CHECK (granted),
  facts_version bigint NOT NULL CHECK (facts_version BETWEEN 0 AND 9007199254740991),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, conversation_id)
);
CREATE INDEX consents_conversation_idx ON public.consents (conversation_id);

CREATE TABLE public.integration_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('crm', 'handoff', 'booking', 'crm_booking_update')),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 256),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  safe_error_code text CHECK (safe_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(external_ids) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('pending', 'succeeded') OR safe_error_code IS NULL),
  CHECK (NOT jsonb_path_exists(external_ids, '$.* ? (@.type() != "string" || @ == "")')),
  UNIQUE (conversation_id, kind, key),
  UNIQUE (id, conversation_id)
);

CREATE TABLE public.handoff_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  consent_id uuid NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  contact jsonb NOT NULL CHECK (jsonb_typeof(contact) = 'object'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (consent_id, conversation_id) REFERENCES public.consents(id, conversation_id),
  FOREIGN KEY (operation_id, conversation_id) REFERENCES public.integration_operations(id, conversation_id)
);
CREATE INDEX handoff_requests_conversation_idx ON public.handoff_requests (conversation_id);

CREATE TABLE public.model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 128),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  safe_error_code text CHECK (safe_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK (status NOT IN ('pending', 'succeeded') OR safe_error_code IS NULL)
);
CREATE INDEX model_runs_conversation_idx ON public.model_runs (conversation_id);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.conversations, public.consents, public.integration_operations,
  public.handoff_requests, public.model_runs FROM PUBLIC;

-- Supabase supplies these roles; keep migration usable in an isolated PostgreSQL database too.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.conversations, public.consents, public.integration_operations, public.handoff_requests, public.model_runs FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversations, public.consents,
      public.integration_operations, public.handoff_requests, public.model_runs TO service_role;
    CREATE POLICY backend_service ON public.conversations TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY backend_service ON public.consents TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY backend_service ON public.integration_operations TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY backend_service ON public.handoff_requests TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY backend_service ON public.model_runs TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
