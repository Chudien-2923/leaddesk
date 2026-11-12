BEGIN;

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL UNIQUE,
  consent_id uuid NOT NULL,
  calendar_id text NOT NULL CHECK (length(trim(calendar_id)) > 0 AND lower(trim(calendar_id)) <> 'primary'),
  event_id text NOT NULL CHECK (event_id ~ '^[0-9a-f]{32}$'),
  start_utc timestamptz NOT NULL,
  end_utc timestamptz NOT NULL CHECK (end_utc > start_utc),
  time_zone text NOT NULL CHECK (time_zone = 'Asia/Ho_Chi_Minh'),
  facts_version bigint NOT NULL CHECK (facts_version BETWEEN 0 AND 9007199254740991),
  policy_version text NOT NULL,
  note_id text NOT NULL CHECK (length(note_id) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'unknown', 'booked', 'failed', 'cancelled')),
  crm_sync_status text NOT NULL DEFAULT 'pending' CHECK (crm_sync_status IN ('pending', 'unknown', 'succeeded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, conversation_id) REFERENCES public.integration_operations(id, conversation_id),
  FOREIGN KEY (consent_id, conversation_id) REFERENCES public.consents(id, conversation_id),
  UNIQUE (calendar_id, event_id)
);
-- Reservations survive ambiguous writes. Only a certain rejection or cancellation releases them.
CREATE UNIQUE INDEX bookings_active_slot ON public.bookings(calendar_id, start_utc)
  WHERE status IN ('pending', 'unknown', 'booked');
CREATE UNIQUE INDEX bookings_active_conversation ON public.bookings(conversation_id)
  WHERE status IN ('pending', 'unknown', 'booked');
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bookings FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.bookings FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bookings TO service_role;
    CREATE POLICY backend_service ON public.bookings TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
COMMIT;
