-- Round 3, phase E: webhooks, one address per organisation, and the deliveries they produce.
--
-- One row per organisation holds the address and the HMAC secret that signs what is sent to it.
-- The secret is stored encrypted with the organisation's key (the same keyring every other secret
-- uses) because the server has to sign with it, and it is shown to the owner once when it is made
-- or rotated. Deliveries keep what the receiver said and when the next try is due.
CREATE TABLE IF NOT EXISTS webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_enc text NOT NULL,
-- The last four characters of the secret, so the owner can tell which one the receiver holds.
  secret_hint text NOT NULL,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One address per organisation: a second would leave the receiver guessing which is real.
CREATE UNIQUE INDEX IF NOT EXISTS webhooks_one_per_org ON webhooks(org_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  event text NOT NULL,
  url text NOT NULL,
  payload jsonb NOT NULL,
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_status int,
  last_response text,
  last_try_at timestamptz,
-- NULL means never again: delivered, blocked, or out of attempts.
  next_retry_at timestamptz DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries(next_retry_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_org_idx ON webhook_deliveries(org_id, created_at DESC);

ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON webhooks;
CREATE POLICY org_isolation ON webhooks USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON webhook_deliveries;
CREATE POLICY org_isolation ON webhook_deliveries USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webhooks TO studio_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webhook_deliveries TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant webhook table privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
