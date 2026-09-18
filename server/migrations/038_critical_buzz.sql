-- Round 3, phase D-8: an unread critical alert keeps making itself known until somebody reads it.
--
-- Two columns on the inbox row: when this alert last went out again, and how many times. A read
-- row is never selected again, so reading it is what stops the buzzing; the count is the cap that
-- stops a forgotten alert from buzzing for ever.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS last_buzzed_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS buzz_count int NOT NULL DEFAULT 0;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_buzz_count_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_buzz_count_check CHECK (buzz_count >= 0);
-- What the buzzer asks for, every ten minutes: unread criticals that are due another reminder.
CREATE INDEX IF NOT EXISTS notifications_unread_critical_idx ON notifications(org_id, last_buzzed_at)
  WHERE read_at IS NULL AND severity = 'critical';
