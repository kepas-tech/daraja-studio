-- Waiting for approval (M4): a fourth role preset, "approver" — someone who can look and can
-- release or refuse a held send, but never sends. The permission behind it is send.approve.
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_role_check;
ALTER TABLE people ADD CONSTRAINT people_role_check CHECK (role IN ('owner','operator','viewer','approver','custom'));
