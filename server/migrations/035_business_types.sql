-- Round 3, phase B: what kind of business this is.
--
-- A clinic, a church, a school and a landlord hold money in different shapes: what an account is
-- called, whether money is expected regularly, whether an invoice is raised, what Home should lead
-- with. That shape is a row of data, not code, so a new kind of business is a new row and needs no
-- deploy, and the owner may edit the words in it.
--
-- One row per organisation per type: every organisation gets its own copy of the shipped nine, so
-- editing "Rental" here never changes anybody else's studio.
CREATE TABLE IF NOT EXISTS business_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,29}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  -- The eight things the plan lists: the account noun, the sub-account noun, whether money is
  -- expected regularly and how often, whether an account stands for a set amount, the payment
  -- categories, whether invoices and reminders are on, what Home leads with, and what this
  -- business's statement is called. Read and written as one object, validated in the service.
  template jsonb NOT NULL,
  seeded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Deleting a kind of business keeps its row as a tombstone: the key is never handed out again, the
  -- list leaves it out, and the seeding below never brings back a kind the owner removed on purpose.
  deleted_at timestamptz,
  UNIQUE (org_id, key)
);

-- Which kind of business this is. A business with no type yet reads as 'other', so an install that
-- predates this file needs no backfill.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS type_key text;
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_type_key_check;
ALTER TABLE businesses ADD CONSTRAINT businesses_type_key_check
  CHECK (type_key IS NULL OR type_key ~ '^[a-z][a-z0-9_]{1,29}$');

ALTER TABLE business_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_types FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON business_types;
CREATE POLICY org_isolation ON business_types USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE business_types TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant business_types privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
