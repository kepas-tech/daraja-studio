-- Step one of the tiers-and-modules design: what this studio does.
--
-- One row per module per organisation. A row is written only when the owner departs from their
-- tier, so its absence means "the tier decides" and the tier's own set never has to be copied into
-- rows that would then need keeping in step. Turning a module off writes false here: it hides the
-- module's screens and refuses its routes, and deletes nothing at all — turning it back on is the
-- same row flipped, or removed again once it matches the tier.
CREATE TABLE IF NOT EXISTS modules (
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 40),
  enabled boolean NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES people(id) ON DELETE SET NULL,
  PRIMARY KEY (org_id, key)
);
CREATE INDEX IF NOT EXISTS modules_org_idx ON modules(org_id);

ALTER TABLE modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON modules;
CREATE POLICY org_isolation ON modules USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE modules TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant modules privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;

-- Every organisation that exists at this point is an install already running the whole surface:
-- the developer side (API keys, webhooks, deliveries) and the payment feed are in use on it today.
-- That is Platform, so it is written down rather than left to a default. An organisation that signs
-- up after this migration has no row here and starts on Business, which is the everyday studio;
-- Platform then stays a deliberate choice, and custody stays off everywhere.
INSERT INTO settings(org_id, key, value) SELECT id, 'org.tier', 'platform' FROM orgs
  ON CONFLICT (org_id, key) DO NOTHING;

-- The owner's own record of who did what gets the same fact, so an upgrade is never a silent
-- change to what their studio shows. person_id is null: no person made this one, the upgrade did.
INSERT INTO audit_log(org_id, action, after_json)
  SELECT id, 'modules.tier_upgraded', '{"tier":"platform"}'::jsonb FROM orgs;
