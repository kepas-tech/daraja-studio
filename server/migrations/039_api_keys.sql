-- Round 3, phase E: API keys, so another system can call this studio.
--
-- A key is two halves: a public prefix that is safe to show in a list, and a secret that is shown
-- once when it is created and never again. Only the hash of the secret is stored, exactly as a
-- password is, and nothing about a key or its value is ever written to an audit row or a log.
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  prefix text NOT NULL CHECK (length(prefix) = 12),
  key_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('operator','viewer','approver')),
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
-- The key a rotation replaced, so the list can show where this one came from.
  rotated_from uuid REFERENCES api_keys(id) ON DELETE SET NULL
);
-- The prefix is the lookup: auth finds the row by it and then compares the secret's hash.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_uniq ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys(org_id, created_at DESC);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON api_keys;
CREATE POLICY org_isolation ON api_keys USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE api_keys TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant api_keys privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
