-- Notifications (feature 4). One row per thing worth telling the owner about, written by the
-- writer that follows the event hub. A repeat of the same dedupe_key bumps `count` instead of
-- writing a second row, so the same failure twice reads as one line with x2, and the row moves to
-- the top of the list. The body is a sentence built from the request row; Safaricom's raw callback
-- JSON is never copied here. read_at is left alone by a repeat: a line the owner has already read
-- stays read.
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('info','success','warning','critical')),
  category text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  count int NOT NULL DEFAULT 1 CHECK (count > 0),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- What makes two of these the same event, and the conflict target the writer's upsert infers.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_org_dedupe_uniq ON notifications(org_id, dedupe_key);
-- The list, newest activity first; the id is in the key so a cursor can be exact.
CREATE INDEX IF NOT EXISTS notifications_org_updated_idx ON notifications(org_id, updated_at DESC, id DESC);
-- The bell count.
CREATE INDEX IF NOT EXISTS notifications_org_unread_idx ON notifications(org_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON notifications;
CREATE POLICY org_isolation ON notifications USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notifications TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant notifications privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
