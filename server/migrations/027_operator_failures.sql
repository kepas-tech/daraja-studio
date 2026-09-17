-- Feature 8: an operator's own health, kept apart from any one request's outcome. One credential
-- refusal is often a stale password that the next call with a fresh token survives, so an operator
-- is only marked failed on the second refusal inside ten minutes, never the first
-- (server/src/money_out/operatorHealth.ts owns the rule).
ALTER TABLE operators ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS down_since timestamptz;
