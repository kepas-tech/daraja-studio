-- Organisations, row-level security, and the limited application role.
-- Every statement is guarded, so running this file again against an already-migrated database
-- changes nothing. What SQL cannot do (decrypting the old install secret to hash it, re-encrypting
-- rows under per-organisation keys) is finished by the boot pass in server/src/boot/tenancy.ts.

-- This migration touches tables it is about to put row-level security on, and FORCE ROW LEVEL
-- SECURITY applies the policies to the table owner as well. Announce ourselves as the system so
-- the migration can still see its own rows on a database whose owner is not a superuser. The
-- setting is transaction-local and migrate() wraps this file in one transaction.
SELECT set_config('app.role', 'system', true);

CREATE TABLE IF NOT EXISTS orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,                      -- host-admin display and URLs; 'org-1' for the migrated org
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','creds_ok','operator_probing','verified','failed','suspended','closed')),
  is_host boolean NOT NULL DEFAULT false,
  -- sha256 hex of the secret; the callback router's lookup key. It is UNIQUE, so the placeholder
  -- 'unset' the migration and the boot pass use can only ever be worn by one organisation at a
  -- time — which is right for 3A (one organisation), and is why bootTenancy's loop over
  -- callback_secret_hash = 'unset' will only ever see a single row here.
  callback_secret_hash text UNIQUE NOT NULL,
  callback_secret_enc text NOT NULL,              -- the secret, encrypted (v2, org key) for Settings › reveal
  key_salt bytea NOT NULL,                        -- 32 random bytes; HKDF salt for this organisation's key
  signup_ip text,
  fail_reason text,
  suspend_reason text CHECK (suspend_reason IN ('unpaid','host')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  suspended_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS orgs_single_host ON orgs(is_host) WHERE is_host;

-- NULL when no organisation is in scope, which makes every policy comparison NULL and every row
-- invisible. Nothing defaults to "all".
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT current_setting('app.role', true) = 'system' $$;

-- Install-wide, master key, no organisation, no RLS: https.seen and (Phase 3C) billing.*.
CREATE TABLE IF NOT EXISTS instance_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  encrypted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  hits int NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);

-- The application role. NOLOGIN: the app connects as DATABASE_URL's user and SET ROLEs into it.
-- A managed PostgreSQL may refuse CREATE ROLE or the GRANT; that must not abort the migration and
-- leave the database stuck on 006, so each is caught and reported. server/src/boot/roleCheck.ts
-- then refuses to boot (hosted) or warns (single) with the exact statement to run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      CREATE ROLE studio_app NOLOGIN NOBYPASSRLS;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'daraja-studio: could not create the studio_app role (%). An administrator must run: CREATE ROLE studio_app NOLOGIN NOBYPASSRLS;', SQLERRM;
    END;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      EXECUTE 'GRANT studio_app TO ' || quote_ident(current_user);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'daraja-studio: could not grant studio_app to % (%). An administrator must run: GRANT studio_app TO %;', current_user, SQLERRM, current_user;
    END;
    BEGIN
      GRANT USAGE ON SCHEMA public TO studio_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO studio_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO studio_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studio_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'daraja-studio: could not grant table privileges to studio_app (%).', SQLERRM;
    END;
  END IF;
END $$;

-- Organisation #1 from whatever is already here. A fresh database has rows in none of the nine
-- tenant tables backfilled below and creates nothing; the boot pass creates it instead
-- (server/src/boot/tenancy.ts). The guard checks every one of those nine, not just settings/people:
-- a Phase 2 install can have sent money (operators/requests/audit_log rows) with nobody ever having
-- written a settings key by hand, and the backfill below would otherwise try to force org_id NOT
-- NULL onto rows with no organisation to fold into.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orgs) AND (
       EXISTS (SELECT 1 FROM settings) OR EXISTS (SELECT 1 FROM people)
    OR EXISTS (SELECT 1 FROM permissions) OR EXISTS (SELECT 1 FROM sessions)
    OR EXISTS (SELECT 1 FROM operators) OR EXISTS (SELECT 1 FROM requests)
    OR EXISTS (SELECT 1 FROM balances) OR EXISTS (SELECT 1 FROM callbacks_raw)
    OR EXISTS (SELECT 1 FROM audit_log)
  ) THEN
    INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt, verified_at)
    VALUES ('org-1',
            COALESCE((SELECT value FROM settings WHERE key = 'org.name'), 'My organisation'),
            CASE WHEN EXISTS (SELECT 1 FROM settings WHERE key = 'setup.completedAt') THEN 'verified' ELSE 'pending' END,
            true,
            'unset',                                                    -- the boot pass hashes the real secret
            COALESCE((SELECT value FROM settings WHERE key = 'install.secret'), 'unset'),
            gen_random_bytes(32),
            (SELECT updated_at FROM settings WHERE key = 'setup.completedAt'));
  END IF;
END $$;

-- org_id on every tenant table, backfilled to organisation #1, defaulted from the session, then RLS.
DO $$
DECLARE t text;
        host_id uuid := (SELECT id FROM orgs WHERE is_host);
BEGIN
  ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;             -- backfill only; re-enabled below
  FOREACH t IN ARRAY ARRAY['settings','people','permissions','sessions','operators','requests','balances','callbacks_raw','audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES orgs(id) ON DELETE CASCADE', t);
    -- Backfill only when there is a host organisation to fold the old rows into. A database with
    -- organisations but none of them the host is a re-run against a hosted install: every row there
    -- already carries an organisation, and blanking them would only make SET NOT NULL fail.
    IF host_id IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET org_id = $1 WHERE org_id IS NULL', t) USING host_id;
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN org_id SET NOT NULL, ALTER COLUMN org_id SET DEFAULT app_current_org()', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (app_is_system() OR org_id = app_current_org())
                    WITH CHECK (app_is_system() OR org_id = app_current_org())', t);
  END LOOP;
  ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;
END $$;

ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self ON orgs;
CREATE POLICY org_self ON orgs USING (app_is_system() OR id = app_current_org())
  WITH CHECK (app_is_system() OR id = app_current_org());

-- Settings keys stop being global.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'settings_pkey' AND conrelid = 'settings'::regclass AND array_length(conkey, 1) = 1) THEN
    ALTER TABLE settings DROP CONSTRAINT settings_pkey;
    ALTER TABLE settings ADD PRIMARY KEY (org_id, key);
  END IF;
END $$;
INSERT INTO instance_settings(key, value, encrypted)
  SELECT key, value, encrypted FROM settings WHERE key = 'https.seen' ON CONFLICT (key) DO NOTHING;
DELETE FROM settings WHERE key IN ('https.seen', 'install.secret');
-- One production organisation per shortcode. A collision raises a bare 23505 for now; the
-- plain-English copy for it belongs with Phase 3B's sign-up screens, which are where a second
-- organisation can first claim a shortcode.
-- The spec's companion index on env.<e>.consumerKeyHash is deliberately NOT created here: nothing
-- writes those keys until 3B's POST /api/signup/daraja, and 3B adds the index beside its writer.
CREATE UNIQUE INDEX IF NOT EXISTS settings_prod_shortcode_uniq ON settings(value) WHERE key = 'env.production.shortcode';

ALTER TABLE people ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'custom'
  CHECK (role IN ('owner','operator','viewer','custom'));
ALTER TABLE people ADD COLUMN IF NOT EXISTS is_host_admin boolean NOT NULL DEFAULT false;
UPDATE people SET role = 'owner' WHERE is_owner AND role = 'custom';
CREATE UNIQUE INDEX IF NOT EXISTS people_email_uniq ON people(lower(email)) WHERE email IS NOT NULL;
-- One owner per organisation instead of one owner per install. username stays UNIQUE install-wide.
DROP INDEX IF EXISTS people_single_owner;
CREATE UNIQUE INDEX IF NOT EXISTS people_single_owner ON people(org_id) WHERE is_owner;

ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS operators_org_name_uniq ON operators(org_id, name);

-- Every hot query is now prefixed by the organisation.
DROP INDEX IF EXISTS requests_status_idx;
CREATE INDEX IF NOT EXISTS requests_org_status_idx ON requests(org_id, status, sent_at);
DROP INDEX IF EXISTS requests_dup_guard_idx;
CREATE INDEX IF NOT EXISTS requests_org_dup_guard_idx ON requests(org_id, recipient_value, amount_cents, created_at DESC);
DROP INDEX IF EXISTS requests_created_by_idx;
CREATE INDEX IF NOT EXISTS requests_org_created_idx ON requests(org_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS balances_org_idx ON balances(org_id, queried_at DESC);
CREATE INDEX IF NOT EXISTS callbacks_raw_org_idx ON callbacks_raw(org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log(org_id, at DESC);
CREATE INDEX IF NOT EXISTS sessions_org_idx ON sessions(org_id);
