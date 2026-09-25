-- Route claims: the words and numbers a customer types as the account on a shared paybill, other than
-- Studio's own numbers. One organisation-wide table, because on a shared paybill (KEPAS's, which
-- hosted businesses without a paybill of their own use) a reference must mean one thing across every
-- business and app on it.
--
--   prefix  an app's lead-in (1, 2, 3, ENABO): the reference is the prefix and then something the app
--           reads (an identifier, a phone). Nothing else may start with it.
--   alias   a whole word that names a business or an app (KEPAS, PAY).
--   name    a whole word a person chose as their account number (JOHN): names one account.
--
-- A business code works like a prefix (Studio's numbers are the code and then digits), so the rule
-- reads codes from businesses as well. The rule lives in one function, route_claim_conflict, which
-- the insert trigger enforces and the name check and the configuration file ask before they claim.

CREATE TABLE IF NOT EXISTS route_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  token text NOT NULL CHECK (token ~ '^[A-Z0-9]{1,12}$'),
  kind text NOT NULL CHECK (kind IN ('prefix', 'alias', 'name')),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  app_id uuid REFERENCES apps(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A claim is released, never deleted: a name someone used stays held from others for a while, so a
  -- payer who still types it is not paying a stranger.
  released_at timestamptz,
  CHECK (
    (kind = 'prefix' AND app_id IS NOT NULL AND account_id IS NULL)
    OR (kind = 'alias' AND num_nonnulls(business_id, app_id) = 1 AND account_id IS NULL)
    OR (kind = 'name' AND (account_id IS NOT NULL OR released_at IS NOT NULL) AND business_id IS NOT NULL AND app_id IS NULL)
  ),
  -- A name has a letter in it: all digits is Studio's own numbering.
  CHECK (kind <> 'name' OR (token ~ '[A-Z]' AND char_length(token) >= 3))
);
CREATE UNIQUE INDEX IF NOT EXISTS route_claims_live ON route_claims(org_id, token) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS route_claims_account ON route_claims(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS route_claims_app ON route_claims(app_id) WHERE app_id IS NOT NULL;

-- Why a token cannot be claimed now, or NULL when it can. p_account is the account a name is for, so
-- an account may take its own released name back.
CREATE OR REPLACE FUNCTION route_claim_conflict(p_org uuid, p_token text, p_kind text, p_account uuid DEFAULT NULL)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT reason FROM (
    SELECT 1 AS o, 'taken' AS reason FROM route_claims c
     WHERE c.org_id = p_org AND c.token = p_token AND c.released_at IS NULL
    UNION ALL
    SELECT 2, 'held' FROM route_claims c
     WHERE c.org_id = p_org AND c.token = p_token AND c.kind = 'name'
       AND c.released_at > now() - interval '12 months'
       AND (p_account IS NULL OR c.account_id IS DISTINCT FROM p_account)
    UNION ALL
    SELECT 3, 'starts_with_prefix' FROM route_claims c
     WHERE c.org_id = p_org AND c.kind = 'prefix' AND c.released_at IS NULL
       AND p_token <> c.token AND left(p_token, char_length(c.token)) = c.token
    UNION ALL
    SELECT 4, 'starts_with_code' FROM businesses b
     WHERE b.org_id = p_org AND left(p_token, char_length(b.code)) = b.code
    UNION ALL
    SELECT 5, 'covers_claim' FROM route_claims c
     WHERE p_kind = 'prefix' AND c.org_id = p_org AND c.released_at IS NULL
       AND c.token <> p_token AND left(c.token, char_length(p_token)) = p_token
    UNION ALL
    SELECT 6, 'covers_code' FROM businesses b
     WHERE p_kind = 'prefix' AND b.org_id = p_org AND left(b.code, char_length(p_token)) = p_token
  ) x ORDER BY o LIMIT 1
$$;

-- Every claim is checked under one lock per organisation, so two people choosing the same name at
-- the same moment get one each or a refusal, never both.
CREATE OR REPLACE FUNCTION route_claims_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE why text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.token <> OLD.token OR NEW.kind <> OLD.kind OR NEW.org_id <> OLD.org_id THEN
      RAISE EXCEPTION 'a route claim cannot change its token, kind or organisation' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.released_at IS NOT NULL AND NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'a released route claim stays released; claim again instead' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('route_claims:' || NEW.org_id::text));
  IF NEW.released_at IS NULL THEN
    why := route_claim_conflict(NEW.org_id, NEW.token, NEW.kind, NEW.account_id);
    IF why IS NOT NULL THEN
      RAISE EXCEPTION 'route claim % refused: %', NEW.token, why USING ERRCODE = 'unique_violation', HINT = why;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS route_claims_check ON route_claims;
CREATE TRIGGER route_claims_check BEFORE INSERT OR UPDATE ON route_claims FOR EACH ROW EXECUTE FUNCTION route_claims_check();

-- An account that goes lets its name go with it (held from others, as any released name is).
CREATE OR REPLACE FUNCTION accounts_release_names() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE route_claims SET released_at = now() WHERE account_id = OLD.id AND released_at IS NULL;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS accounts_release_names ON accounts;
CREATE TRIGGER accounts_release_names BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_release_names();

ALTER TABLE route_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON route_claims;
CREATE POLICY org_isolation ON route_claims USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE ON TABLE route_claims TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant route_claims privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
