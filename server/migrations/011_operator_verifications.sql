CREATE TABLE IF NOT EXISTS org_environment_verifications (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  verified_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, environment)
);

SELECT set_config('app.role', 'system', true);

INSERT INTO org_environment_verifications (org_id, environment, verified_at)
SELECT org_id, environment, MIN(last_probe_at)
FROM operators
WHERE status = 'verified' AND last_probe_at IS NOT NULL
GROUP BY org_id, environment
ON CONFLICT (org_id, environment) DO NOTHING;

ALTER TABLE org_environment_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_environment_verifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_environment_verifications_select ON org_environment_verifications;
CREATE POLICY org_environment_verifications_select ON org_environment_verifications
  FOR SELECT USING (app_is_system() OR org_id = app_current_org());
DROP POLICY IF EXISTS org_environment_verifications_insert ON org_environment_verifications;
CREATE POLICY org_environment_verifications_insert ON org_environment_verifications
  FOR INSERT WITH CHECK (app_is_system() OR org_id = app_current_org());
DROP POLICY IF EXISTS org_environment_verifications_update ON org_environment_verifications;
CREATE POLICY org_environment_verifications_update ON org_environment_verifications
  FOR UPDATE USING (app_is_system()) WITH CHECK (app_is_system());
DROP POLICY IF EXISTS org_environment_verifications_delete ON org_environment_verifications;
CREATE POLICY org_environment_verifications_delete ON org_environment_verifications
  FOR DELETE USING (app_is_system());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      REVOKE ALL PRIVILEGES ON TABLE org_environment_verifications FROM studio_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE org_environment_verifications TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant org_environment_verifications privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
