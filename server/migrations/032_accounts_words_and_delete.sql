-- Brief 2, item 1b (owner's rule, 2026-09-17). Two changes:
--
-- Words. The level-2 thing is not always a customer — it can be a clinic, a church, a room, a plot,
-- a tenant — so the generic words are business, account and sub-account. The tracker's scope kind
-- follows them.
--
-- Delete means delete. The earlier rule (retire, keep the row, never reuse) is replaced: deleting
-- removes the row and its sub-accounts, the number returns to the free pool of its width, and a
-- later mint may hand the same digits to somebody else. What must not be lost is who held it, so
-- number_history keeps one row per deleted thing: no more than that, and nothing blocks the reuse.

UPDATE number_widths SET scope_kind = 'accounts' WHERE scope_kind = 'customers';
ALTER TABLE number_widths DROP CONSTRAINT IF EXISTS number_widths_scope_kind_check;
ALTER TABLE number_widths ADD CONSTRAINT number_widths_scope_kind_check
  CHECK (scope_kind IN ('accounts', 'sub_accounts'));

-- A deleted row leaves nothing behind, so the column that marked a row retired has no meaning.
ALTER TABLE accounts DROP COLUMN IF EXISTS retired_at;
-- The mint asks which widths have a free number, per scope; this is that question's index.
CREATE INDEX IF NOT EXISTS accounts_scope_width_idx ON accounts(business_id, parent_id, char_length(number));

/**
 * One row per thing that was deleted while it had a number: the digits, who held them, when they
 * were handed out and when they came back. `phone` is here because the owner may need to recognise
 * the holder; nothing else about the row is kept, and it is never a payment record.
 */
CREATE TABLE IF NOT EXISTS number_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  business_code char(3) NOT NULL CHECK (business_code ~ '^[0-9]{3}$'),
  full_number text NOT NULL,
  level text NOT NULL CHECK (level IN ('business', 'account', 'sub_account')),
  name text NOT NULL,
  phone text,
  created_at timestamptz NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid REFERENCES people(id) ON DELETE SET NULL
);
-- The three places it is read: one number's whole past, the newest holder of one number, and a
-- number that was handed out again within the last twelve months.
CREATE INDEX IF NOT EXISTS number_history_number_idx ON number_history(org_id, full_number, deleted_at DESC);

ALTER TABLE number_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON number_history;
CREATE POLICY org_isolation ON number_history USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      -- Append-only for the application role: history is written once and never edited.
      GRANT SELECT, INSERT ON TABLE number_history TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant number_history privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;

-- requests.business_id and requests.account_id are already ON DELETE SET NULL (025, 030): the money
-- row keeps the digits it was labelled with, and the history row carries the meaning from then on.
