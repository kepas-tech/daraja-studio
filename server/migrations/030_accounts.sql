-- Account numbers, made exact (brief 2, item 1). Three levels, digits only, every digit chosen by
-- Studio: a three-digit business code, a customer number that starts at three digits and grows on
-- the right only when every shorter one is used, and an optional sub-account under a customer.
-- A number is never edited and never re-pointed, and retiring keeps the row so the number stays out
-- of circulation for ever. Replaces feature 2's sequential customer numbers (migration 025).
--
-- Width is written into the number itself: a leading 9 means "one digit longer than the base", so a
-- number of width 3 is 000-899, of width 4 is 9000-9899, of width 5 is 99000-99899, and so on. The
-- shape below is also the reader: count the leading 9s, take 3 + that many digits. Nothing about a
-- payer's number can therefore be read two ways, and no lookup is needed to split it.
--
-- The table is renamed in place, so its rows, its RLS policy and the studio_app grant all come
-- along; `full_number` cannot be a generated column because it reads two other rows, so a trigger
-- fills it and enforces the rules that must hold even for a direct SQL insert.

ALTER TABLE customers RENAME TO accounts;
ALTER TABLE accounts RENAME COLUMN deleted_at TO retired_at;
ALTER TABLE accounts RENAME COLUMN number TO number_int;

-- The digits at this level only: '359' for a customer, '123' for an account under it.
ALTER TABLE accounts ADD COLUMN number text;
UPDATE accounts SET number = lpad(number_int::text, 3, '0');
ALTER TABLE accounts ALTER COLUMN number SET NOT NULL;
ALTER TABLE accounts ALTER COLUMN number DROP DEFAULT;
ALTER TABLE accounts ADD CONSTRAINT accounts_number_digits CHECK (number ~ '^9*[0-8][0-9]{2}$');
ALTER TABLE accounts DROP COLUMN number_int;

ALTER TABLE accounts ADD COLUMN parent_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE accounts ADD COLUMN full_number text;

-- Live and retired rows share the index: a retired number is never handed out again.
DROP INDEX IF EXISTS customers_business_number_uniq;
DROP INDEX IF EXISTS customers_org_business_idx;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_business_number_uniq
  ON accounts(business_id, number) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_business_parent_number_uniq
  ON accounts(business_id, parent_id, number) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_full_number_uniq ON accounts(org_id, full_number);
CREATE INDEX IF NOT EXISTS accounts_org_business_idx ON accounts(org_id, business_id) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS accounts_parent_idx ON accounts(parent_id) WHERE parent_id IS NOT NULL;

/**
 * Fill `full_number` and hold the three rules a number must never break, whatever writes the row:
 * a parent lives in the same business, a parent is itself a customer account (depth one), and the
 * whole number is at most twelve digits — Daraja's AccountReference limit. An UPDATE may not touch
 * the number, the parent or the business: a number is never edited and never re-pointed.
 */
CREATE OR REPLACE FUNCTION accounts_number_guard() RETURNS trigger AS $guard$
DECLARE
  biz_code text;
  parent_number text;
  parent_business uuid;
  parent_parent uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.number IS DISTINCT FROM OLD.number
       OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
      RAISE EXCEPTION 'an account number is never changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT code::text INTO biz_code FROM businesses WHERE id = NEW.business_id;
  IF biz_code IS NULL THEN
    RAISE EXCEPTION 'an account must belong to a business' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT a.number, a.business_id, a.parent_id INTO parent_number, parent_business, parent_parent
      FROM accounts a WHERE a.id = NEW.parent_id;
    IF parent_number IS NULL THEN
      RAISE EXCEPTION 'the account this one sits under does not exist' USING ERRCODE = '23503';
    END IF;
    IF parent_parent IS NOT NULL THEN
      RAISE EXCEPTION 'an account under an account is not allowed' USING ERRCODE = '23514';
    END IF;
    IF parent_business <> NEW.business_id THEN
      RAISE EXCEPTION 'an account and its parent must be in the same business' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.full_number := biz_code || COALESCE(parent_number, '') || NEW.number;
  IF char_length(NEW.full_number) > 12 THEN
    RAISE EXCEPTION 'an account number is at most 12 digits' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS accounts_number_guard ON accounts;
CREATE TRIGGER accounts_number_guard BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_number_guard();

-- Any row that came across from `customers` gets its full number now; a no-op update still fires
-- the trigger above.
UPDATE accounts SET updated_at = updated_at;
ALTER TABLE accounts ALTER COLUMN full_number SET NOT NULL;

/**
 * One row per width a scope has opened. The scope is a business for customer numbers, and a customer
 * account for the accounts under it. Minting reads the open row: while fewer than 900 numbers of that
 * width are used it draws one; at 900 it closes the row and opens the next width, which is the event
 * the owner hears about. Retired numbers still count as used, so a width never reopens.
 */
CREATE TABLE IF NOT EXISTS number_widths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  scope_kind text NOT NULL CHECK (scope_kind IN ('customers', 'sub_accounts')),
  scope_id uuid NOT NULL,
  width integer NOT NULL CHECK (width BETWEEN 3 AND 12),
  capacity integer NOT NULL DEFAULT 900 CHECK (capacity > 0),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (org_id, scope_kind, scope_id, width)
);
CREATE INDEX IF NOT EXISTS number_widths_open_idx ON number_widths(scope_kind, scope_id) WHERE closed_at IS NULL;

ALTER TABLE number_widths ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_widths FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON number_widths;
CREATE POLICY org_isolation ON number_widths USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

-- The money row points at either level: a customer account, or one of the accounts under it.
ALTER TABLE requests RENAME COLUMN customer_id TO account_id;
ALTER INDEX IF EXISTS requests_customer_idx RENAME TO requests_account_idx;

-- The policy, the FORCE and the grant came with the rename; re-state them so a database restored
-- from an older dump ends up in the same place.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON accounts;
CREATE POLICY org_isolation ON accounts USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE accounts, number_widths TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant accounts privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
