BEGIN;

CREATE TABLE public.knowledge_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id text NOT NULL CHECK (length(admin_id) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preparing', 'ready', 'failed')),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  model_id text NOT NULL DEFAULT 'Xenova/multilingual-e5-small',
  model_revision text NOT NULL DEFAULT '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  dimensions integer NOT NULL DEFAULT 384 CHECK (dimensions = 384),
  failure_code text CHECK (failure_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (status <> 'ready' OR (published_at IS NOT NULL AND failure_code IS NULL))
);
CREATE TABLE public.knowledge_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL REFERENCES public.knowledge_releases(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 256),
  body text NOT NULL CHECK (length(btrim(body)) > 0 AND char_length(body) <= 20000),
  kind text NOT NULL CHECK (kind IN ('services', 'pricing', 'faq', 'policies')),
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  PRIMARY KEY (id, release_id),
  UNIQUE (id, release_id, visibility)
);
CREATE INDEX knowledge_documents_release_idx ON public.knowledge_documents (release_id);
CREATE TABLE public.knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  release_id uuid NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'internal')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  text text NOT NULL CHECK (length(text) > 0),
  token_count integer NOT NULL CHECK (token_count BETWEEN 1 AND 512),
  embedding vector(384) NOT NULL,
  FOREIGN KEY (document_id, release_id, visibility) REFERENCES public.knowledge_documents(id, release_id, visibility) ON DELETE CASCADE,
  UNIQUE (document_id, release_id, ordinal)
);
CREATE INDEX knowledge_chunks_scope_idx ON public.knowledge_chunks (release_id, visibility);
-- Exact ranking inside the release/public scope is intentional for this small local dataset.
CREATE TABLE public.knowledge_active_release (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  release_id uuid NOT NULL UNIQUE REFERENCES public.knowledge_releases(id),
  activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.require_ready_knowledge_release() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM knowledge_releases WHERE id = NEW.release_id AND status = 'ready') THEN
    RAISE EXCEPTION 'Active knowledge release must be ready';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_active_ready BEFORE INSERT OR UPDATE ON public.knowledge_active_release
  FOR EACH ROW EXECUTE FUNCTION public.require_ready_knowledge_release();

ALTER TABLE public.knowledge_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_active_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.knowledge_releases, public.knowledge_documents, public.knowledge_chunks, public.knowledge_active_release FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_ready_knowledge_release() FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.knowledge_releases, public.knowledge_documents, public.knowledge_chunks, public.knowledge_active_release FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.knowledge_releases, public.knowledge_documents, public.knowledge_chunks, public.knowledge_active_release TO service_role;
    CREATE POLICY backend_service ON public.knowledge_releases TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY backend_service ON public.knowledge_documents TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY backend_service ON public.knowledge_chunks TO service_role USING (true) WITH CHECK (true);
    CREATE POLICY backend_service ON public.knowledge_active_release TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
COMMIT;
