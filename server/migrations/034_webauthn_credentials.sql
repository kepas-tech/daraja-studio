-- Brief 2, item 5b: the fingerprints that can open a locked session. One row per credential, the
-- public key only — the private key never leaves the device, so nothing here is a secret that could
-- be replayed. The counter is kept so a signature that goes backwards (a cloned authenticator) can be
-- refused, and device_label is a friendly word for the Organisation list. Nothing in this table is
-- ever logged: no identifier, no key, no counter.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id text PRIMARY KEY,
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[],
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
-- What the lock screen asks: does this person have one at all.
CREATE INDEX IF NOT EXISTS webauthn_credentials_person_idx ON webauthn_credentials(org_id, person_id);

ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON webauthn_credentials;
CREATE POLICY org_isolation ON webauthn_credentials USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE webauthn_credentials TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant webauthn_credentials privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
