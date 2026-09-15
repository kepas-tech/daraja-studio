-- Only an operator Safaricom has accepted is kept. verified_at records that first acceptance;
-- an operator that fails before it is set is dropped rather than stored as failed, while one
-- that once worked keeps its row (priority, history) and is marked failed instead.
ALTER TABLE operators ADD COLUMN IF NOT EXISTS verified_at timestamptz;

SELECT set_config('app.role', 'system', true);
UPDATE operators SET verified_at = COALESCE(last_probe_at, created_at) WHERE status = 'verified' AND verified_at IS NULL;
