-- Round 3, phase C: the standing amount one account is expected to pay each period.
--
-- Phase B gave a kind of business a shape: whether money is expected regularly and how often, and
-- whether each account stands for a set amount. This is where that amount lives — the rent, the
-- fee, the monthly contribution — so the statement can say what was expected by now and who is
-- behind. It is one number per account, set by the owner, and it never moves money on its own.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS standing_cents integer;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_standing_cents_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_standing_cents_check
  CHECK (standing_cents IS NULL OR standing_cents > 0);

-- When a reminder was last prepared for this account, so the owner can see it was done and when.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
