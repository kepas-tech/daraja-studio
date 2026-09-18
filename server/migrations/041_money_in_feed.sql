-- Round 5: payments fed in by another system that owns the paybill's C2B addresses.
--
-- A fed payment is neither a callback nor a poll: another system received Safaricom's confirmation
-- and posted the same body to Studio's inbox. It gets its own result_source so every screen and
-- every report can tell the three apart, and so the final-row guard treats it exactly as it treats
-- the other two.
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_result_source_check;
ALTER TABLE requests ADD CONSTRAINT requests_result_source_check
  CHECK (result_source IS NULL OR result_source IN ('callback','poll','ack','feed'));

-- The key that feeds money in is limited to that and nothing else, so it needs a role of its own.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_role_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_role_check
  CHECK (role IN ('operator','viewer','approver','forwarder'));
