-- D-003 (revised S1): a sandbox sign-up may be verified by Safaricom's synchronous acknowledgement
-- of an operator probe. An acknowledgement is not a callback and must never be recorded as one, so
-- result_source gains its own value. Production keeps the strict callback rule.
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_result_source_check;
ALTER TABLE requests ADD CONSTRAINT requests_result_source_check
  CHECK (result_source IS NULL OR result_source IN ('callback', 'poll', 'ack'));
