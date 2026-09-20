-- 046: a role for the system that takes this studio's payments, and carries nothing else.
--
-- An application that asks for payments needs exactly two permissions: ask for one (stk.request) and
-- read one back (lookup.view). The nearest existing role, operator, also carries the sends, the bulk
-- batches and the case file — powers a payments integration has no use for, and an API key is a
-- credential that outlives the conversation in which it was handed over. Migration 041 added
-- 'forwarder' for the same reason, for the system that feeds money in; this is the mirror of it.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_role_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_role_check
  CHECK (role IN ('operator','viewer','approver','forwarder','collector'));
