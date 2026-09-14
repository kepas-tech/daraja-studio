ALTER TABLE operators
  ADD COLUMN environment text NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox','production'));
CREATE INDEX operators_environment_status_idx ON operators(environment, status);

-- One shared Daraja key/secret/passkey/shortcode used to serve every environment, so switching
-- daraja.environment from sandbox to production overwrote the sandbox values with no way back.
-- Move whatever is there into a slot for the environment it was last known to belong to
-- (daraja.credsEnv when Safaricom had accepted it, else the current daraja.environment, else
-- sandbox) and drop the old keys. Guarded by existence checks so re-running this file against an
-- already-migrated database (old keys absent) is a no-op.
DO $$
DECLARE
  target text;
  had_creds_env boolean;
BEGIN
  had_creds_env := EXISTS (SELECT 1 FROM settings WHERE key = 'daraja.credsEnv');
  SELECT COALESCE(
    (SELECT value FROM settings WHERE key = 'daraja.credsEnv'),
    (SELECT value FROM settings WHERE key = 'daraja.environment'),
    'sandbox'
  ) INTO target;
  -- A direct DB write (or corruption) could put anything in daraja.environment/daraja.credsEnv;
  -- sdk/client.ts already refuses to build a client for anything but sandbox/production, so a
  -- junk value here must not silently create an unreachable env.<junk>.* key.
  IF target NOT IN ('sandbox', 'production') THEN
    target := 'sandbox';
  END IF;

  -- An operator's credential was generated from the certificate belonging to the environment
  -- credentials were verified against, so a 'verified' operator provably belongs to `target`.
  -- Every other operator (pending/failed/disabled) keeps the column's own 'sandbox' default.
  UPDATE operators SET environment = target WHERE status = 'verified';

  IF EXISTS (SELECT 1 FROM settings WHERE key = 'daraja.consumerKey') THEN
    INSERT INTO settings(key, value, encrypted)
      SELECT 'env.' || target || '.consumerKey', value, encrypted FROM settings WHERE key = 'daraja.consumerKey'
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = now();
    DELETE FROM settings WHERE key = 'daraja.consumerKey';
  END IF;

  IF EXISTS (SELECT 1 FROM settings WHERE key = 'daraja.consumerSecret') THEN
    INSERT INTO settings(key, value, encrypted)
      SELECT 'env.' || target || '.consumerSecret', value, encrypted FROM settings WHERE key = 'daraja.consumerSecret'
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = now();
    DELETE FROM settings WHERE key = 'daraja.consumerSecret';
  END IF;

  IF EXISTS (SELECT 1 FROM settings WHERE key = 'daraja.passkey') THEN
    INSERT INTO settings(key, value, encrypted)
      SELECT 'env.' || target || '.passkey', value, encrypted FROM settings WHERE key = 'daraja.passkey'
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = now();
    DELETE FROM settings WHERE key = 'daraja.passkey';
  END IF;

  IF EXISTS (SELECT 1 FROM settings WHERE key = 'daraja.certPem') THEN
    INSERT INTO settings(key, value, encrypted)
      SELECT 'env.' || target || '.certPem', value, encrypted FROM settings WHERE key = 'daraja.certPem'
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = now();
    DELETE FROM settings WHERE key = 'daraja.certPem';
  END IF;

  IF EXISTS (SELECT 1 FROM settings WHERE key = 'org.shortcode') THEN
    INSERT INTO settings(key, value, encrypted)
      SELECT 'env.' || target || '.shortcode', value, encrypted FROM settings WHERE key = 'org.shortcode'
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = now();
    DELETE FROM settings WHERE key = 'org.shortcode';
  END IF;

  IF had_creds_env THEN
    INSERT INTO settings(key, value, encrypted)
      VALUES ('env.' || target || '.credsVerifiedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || 'Z', false)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = now();
    DELETE FROM settings WHERE key = 'daraja.credsEnv';
  END IF;
END $$;
