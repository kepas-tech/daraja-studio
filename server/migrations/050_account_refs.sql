-- An app's own user, as an account. kepas-pay tells an app which of its users paid by an identifier
-- the app registered; Studio's answer is an account per user under the app's business, found by the
-- app's own reference for that user (its user id, say). Asking a user to pay then quotes that
-- account's number, so the money names the user even when the prompt's own answer is lost, and a
-- user who pays the paybill directly with the number is known the same way.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_ref text
  CHECK (external_ref IS NULL OR char_length(external_ref) BETWEEN 1 AND 64);
-- One account per user per business: the get-or-create is also guarded by the mint's own lock.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_business_external_ref ON accounts(business_id, external_ref) WHERE external_ref IS NOT NULL;

-- The business a key acts for. A key that opens accounts for its users opens them here and nowhere
-- else; a key with no business may not open any.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;
