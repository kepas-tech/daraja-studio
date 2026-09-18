-- Round 3, phase D-5: the case file on a payment that went wrong.
--
-- One table for the case and one for what was done about it. A case belongs to one payment and
-- moves no money: it records what happened, who looked, and how it ended. Nothing is deleted; a
-- closed case keeps its notes and stays readable on the payment's own page.
CREATE TABLE IF NOT EXISTS request_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by uuid REFERENCES people(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES people(id) ON DELETE SET NULL,
  closed_at timestamptz,
  outcome text,
  -- A case is open exactly while it has not been closed, and a closed one says how it ended.
  CONSTRAINT request_cases_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT request_cases_outcome CHECK (status = 'open' OR (outcome IS NOT NULL AND length(btrim(outcome)) > 0))
);
-- One open case per payment: a second one would split the same story in two.
CREATE UNIQUE INDEX IF NOT EXISTS request_cases_one_open ON request_cases(org_id, request_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS request_cases_request_idx ON request_cases(org_id, request_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS case_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES request_cases(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (length(btrim(note)) > 0),
  by_person uuid REFERENCES people(id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_notes_case_idx ON case_notes(org_id, case_id, at ASC);

ALTER TABLE request_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON request_cases;
CREATE POLICY org_isolation ON request_cases USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE case_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON case_notes;
CREATE POLICY org_isolation ON case_notes USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE request_cases TO studio_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE case_notes TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant case table privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
