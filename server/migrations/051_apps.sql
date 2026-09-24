-- An app: another system that takes payments through this studio for one of its businesses (sinro,
-- enabo, KodiSap, Wabi, Tumakesh on the KEPAS paybill). It is declared in the studio's configuration
-- file (server/src/configfile) and holds what the hub needs to know about it: its business, whether
-- Studio or kepas-pay is the hub that credits it today, whether it holds its users' money here, and
-- the paybill references that name it. The key it calls with, and the address it is told at, are the
-- ordinary API key and key webhook, linked back here.

CREATE TABLE IF NOT EXISTS apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  -- A short name for files and logs: lowercase letters, digits and hyphens.
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,31}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- pass_through: the money is the business's, nothing is held per user. custody: users hold
  -- balances here (wallets, phase 4).
  mode text NOT NULL DEFAULT 'pass_through' CHECK (mode IN ('pass_through', 'custody')),
  -- Which hub credits this app's payments today. Exactly one ever does (plan, phase 7).
  hub text NOT NULL DEFAULT 'kepas' CHECK (hub IN ('kepas', 'studio')),
  -- A phone after the app's prefix names a user of this app, and only of this app.
  phone_routing boolean NOT NULL DEFAULT false,
  -- The paybill references that name this app, as declared (routing claims take effect in phase 3).
  prefixes text[] NOT NULL DEFAULT '{}',
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS apps_org_key ON apps(org_id, key);
-- One app per business: the business's money and its app's notices are the same thing.
CREATE UNIQUE INDEX IF NOT EXISTS apps_org_business ON apps(org_id, business_id);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES apps(id) ON DELETE SET NULL;

ALTER TABLE apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON apps;
CREATE POLICY org_isolation ON apps USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE apps TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant apps privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
