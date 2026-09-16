-- Contacts (feature 1 of the KEPAS Pay borrow list): the saved address book for the people and
-- businesses this studio pays. One row is one of three shapes — a phone number, a till number, or a
-- paybill number with an optional account reference. The shape is checked here as well as in
-- server/src/contacts/routes.ts: the database is the last line, not the only one.
-- Deleting a contact is soft (deleted_at): History keeps the name a payment was made under, and the
-- partial unique index below lets a retired name be used again.
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('phone','till','paybill')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  -- 2547XXXXXXXX and 2541XXXXXXXX are both real M-Pesa numbers, which is exactly what the SDK's
  -- normalizePhone produces; the column stores that normalised form and nothing else.
  phone text CHECK (phone IS NULL OR phone ~ '^254[0-9]{9}$'),
  shortcode text CHECK (shortcode IS NULL OR shortcode ~ '^[0-9]{5,7}$'),
  account_reference text CHECK (account_reference IS NULL OR account_reference ~ '^[A-Za-z0-9]{1,20}$'),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  created_by uuid REFERENCES people(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- The KEPAS Pay migration 015 idea, said as SQL: a phone row has a phone and nothing else, a till
  -- row has a shortcode and nothing else, a paybill row has a shortcode and at most an account.
  CONSTRAINT contacts_kind_shape CHECK (
    CASE kind
      WHEN 'phone' THEN phone IS NOT NULL AND shortcode IS NULL AND account_reference IS NULL
      WHEN 'till' THEN shortcode IS NOT NULL AND phone IS NULL AND account_reference IS NULL
      WHEN 'paybill' THEN shortcode IS NOT NULL AND phone IS NULL
    END
  )
);
-- One live name per organisation, so a duplicate is a plain 409 in the route instead of two rows
-- nobody can tell apart. Partial, so a soft-deleted name is free again.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_name_uniq ON contacts(org_id, lower(name)) WHERE deleted_at IS NULL;
-- The Phone / Till / Paybill tabs.
CREATE INDEX IF NOT EXISTS contacts_org_kind_idx ON contacts(org_id, kind) WHERE deleted_at IS NULL;

-- History shows the name a payment was made under, so the request points at the contact. SET NULL on
-- delete keeps the request row itself untouched if a contact is ever hard-deleted.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS requests_contact_idx ON requests(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON contacts;
CREATE POLICY org_isolation ON contacts USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE contacts TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant contacts privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
