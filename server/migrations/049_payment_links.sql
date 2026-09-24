-- A payment Studio asked for (an STK prompt, an express checkout, a standing order) and the
-- confirmation Safaricom then posts for the same money are two rows with one receipt. Until now
-- nothing joined them, so a business's sweep and statement could count the money twice, and the
-- confirmation, which is the row shown as "money in", never knew which key or which caller's
-- reference asked for it (sinro's first top-up through Studio, 24 September 2026).
--
-- The pair is now linked both ways. The confirmation is the row that counts; the prompt is kept,
-- with its own history, and points at it. Linking writes labels only, never an amount, status or
-- receipt, so the final-row guard of migration 004 is untouched.

ALTER TABLE requests ADD COLUMN IF NOT EXISTS prompt_id uuid REFERENCES requests(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS confirmation_id uuid REFERENCES requests(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS link_method text
  CHECK (link_method IS NULL OR link_method IN ('receipt', 'inferred', 'manual'));

-- One partner each, never two.
CREATE UNIQUE INDEX IF NOT EXISTS requests_prompt_once ON requests(prompt_id) WHERE prompt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS requests_confirmation_once ON requests(confirmation_id) WHERE confirmation_id IS NOT NULL;
-- What the link and the count-once rule look up.
CREATE INDEX IF NOT EXISTS requests_receipt_idx ON requests(org_id, receipt) WHERE receipt IS NOT NULL;

-- The pairs already on record: exactly one prompt and exactly one confirmation for a receipt in an
-- organisation. Anything more ambiguous is left alone for a person.
WITH prompts AS (
  SELECT org_id, receipt, (array_agg(id))[1] AS id, count(*) AS n
    FROM requests WHERE type IN ('stk', 'express', 'ratiba') AND status = 'completed' AND receipt IS NOT NULL
   GROUP BY org_id, receipt
), confirmations AS (
  SELECT org_id, receipt, (array_agg(id))[1] AS id, count(*) AS n
    FROM requests WHERE type IN ('c2b', 'invoice_payment') AND receipt IS NOT NULL
   GROUP BY org_id, receipt
), pairs AS (
  SELECT p.id AS prompt, c.id AS confirmation
    FROM prompts p JOIN confirmations c ON c.org_id = p.org_id AND c.receipt = p.receipt
   WHERE p.n = 1 AND c.n = 1
)
UPDATE requests r SET
  prompt_id = CASE WHEN r.id = pairs.confirmation THEN pairs.prompt ELSE r.prompt_id END,
  confirmation_id = CASE WHEN r.id = pairs.prompt THEN pairs.confirmation ELSE r.confirmation_id END,
  link_method = 'receipt'
  FROM pairs
 WHERE r.id IN (pairs.prompt, pairs.confirmation);

-- The confirmation takes the labels only the prompt knew, where it has none of its own.
UPDATE requests c SET
  business_id = COALESCE(c.business_id, p.business_id),
  account_id  = COALESCE(c.account_id, p.account_id),
  caller_ref  = COALESCE(c.caller_ref, p.caller_ref),
  api_key_id  = COALESCE(c.api_key_id, p.api_key_id)
  FROM requests p
 WHERE c.prompt_id = p.id;
