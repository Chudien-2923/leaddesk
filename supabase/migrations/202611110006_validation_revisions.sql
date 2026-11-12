BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN facts_validation_pending boolean NOT NULL DEFAULT false;
-- Old rows have no reliable validation receipt. Require a new validated message before new writes.
UPDATE public.conversations SET facts_validation_pending = true
WHERE facts <> '{}'::jsonb OR CASE WHEN jsonb_typeof(state->'messages') = 'array'
  THEN jsonb_array_length(state->'messages') > 0 ELSE false END;

ALTER TABLE public.knowledge_releases ADD CONSTRAINT knowledge_policy_revision_length
  CHECK (char_length(policy->>'version') BETWEEN 1 AND 128);

CREATE TABLE public.agency_policy_versions (
  version text PRIMARY KEY CHECK (char_length(version) BETWEEN 1 AND 128),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'
    AND COALESCE(jsonb_typeof(policy->'version') = 'string' AND policy->>'version' = version, false)),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF EXISTS (
    SELECT policy->>'version' FROM public.knowledge_releases WHERE status = 'ready'
    GROUP BY policy->>'version' HAVING count(DISTINCT policy) > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting ready policy revisions require explicit reconciliation before upgrade';
  END IF;
END $$;
INSERT INTO public.agency_policy_versions(version, policy)
  SELECT DISTINCT policy->>'version', policy FROM public.knowledge_releases WHERE status = 'ready';

ALTER TABLE public.agency_policy_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agency_policy_versions FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.agency_policy_versions FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT ON TABLE public.agency_policy_versions TO service_role;
    CREATE POLICY backend_service ON public.agency_policy_versions TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
COMMIT;
