BEGIN;

CREATE SCHEMA IF NOT EXISTS leaddesk_private;
REVOKE ALL ON SCHEMA leaddesk_private FROM PUBLIC;
CREATE TABLE leaddesk_private.http_rate_limits (
  scope text NOT NULL CHECK (scope IN ('message', 'creation')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used BETWEEN 1 AND 20),
  PRIMARY KEY (scope, key_hash)
);
COMMENT ON TABLE leaddesk_private.http_rate_limits IS
  'Server-only atomic hourly counters. message keys hash authenticated conversation UUIDs; creation hashes one conservative shared loopback peer scope because Request has no verified socket IP. Forwarded IP headers are never trusted.';
ALTER TABLE leaddesk_private.http_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leaddesk_private.http_rate_limits FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA leaddesk_private FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE leaddesk_private.http_rate_limits FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT USAGE ON SCHEMA leaddesk_private TO service_role;
    GRANT SELECT, INSERT, UPDATE ON TABLE leaddesk_private.http_rate_limits TO service_role;
    CREATE POLICY backend_service ON leaddesk_private.http_rate_limits TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
