-- Brief 2, item 3: the PIN lock. An optional six-digit PIN, per person, hashed with argon2id
-- exactly like a password, and one flag per session holding the moment that session was last
-- unlocked. The PIN itself is never stored, never logged and never written to an audit row: what
-- lives here is a hash and two timestamps. NULL in pin_entered_at means locked, which is how a
-- session starts after a page load and after returning from the background; the same column is
-- read against a 30-minute window for the idle rule (auth/pin.ts).
ALTER TABLE people ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS pin_set_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pin_entered_at timestamptz;
