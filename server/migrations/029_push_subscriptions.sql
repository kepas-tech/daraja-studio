-- Web push (feature 12, second half). One row per browser that agreed to be told about the
-- inbox while no Studio tab is open. The endpoint, p256dh and auth are the browser's own
-- subscription: together they are a capability to put a message on that device, so they are stored
-- (they have to be, to send) but never logged, never copied into a report and never put in an audit
-- row. A row whose push service answers 404 or 410, or that fails five times in a row, is marked
-- gone_at: it is skipped, and a later subscribe with the same address revives it.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failed_at timestamptz,
  failures int NOT NULL DEFAULT 0 CHECK (failures >= 0),
  gone_at timestamptz
);
-- One row per browser subscription. The conflict target is what lets the same browser switch person:
-- the person signed in now takes the device over.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_org_endpoint_uniq ON push_subscriptions(org_id, endpoint);
-- What the sender reads: the live subscriptions of one organisation.
CREATE INDEX IF NOT EXISTS push_subscriptions_live_idx ON push_subscriptions(org_id) WHERE gone_at IS NULL;

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON push_subscriptions;
CREATE POLICY org_isolation ON push_subscriptions USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE push_subscriptions TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant push_subscriptions privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
