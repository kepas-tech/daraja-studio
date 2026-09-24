-- Scheduled payments: pay the same people on a timetable. Design: scheduled-payments-design.md.
--
-- Consent is given once, when a schedule is created, behind the step-up and a warning that has to be
-- accepted; after that each payment goes on its own. What still refuses to go on its own: a float
-- that cannot cover the whole run (nobody is paid, and the gap is named), and a failed line, which is
-- reported and never sent again by itself.
--
-- Four tables:
--   schedules          the timetable, who consented, and whether it is on.
--   schedule_lines     who is paid and how much. A payee is a saved contact: a phone, a till, or a
--                      paybill with its account number.
--   pay_runs           one row per schedule per nominal date. UNIQUE (schedule_id, due_on) is what
--                      makes a retry, a restart, two schedulers or a clock slip unable to pay twice.
--   pay_run_lines      a copy of every line as it stood that day, so editing a schedule never
--                      rewrites what was paid, and the money-out row that carried each one.

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  every text NOT NULL CHECK (every IN ('daily','weekly','fortnightly','monthly')),
  -- 0 is Monday. Weekly and fortnightly only.
  weekday smallint NOT NULL DEFAULT 0 CHECK (weekday BETWEEN 0 AND 6),
  -- Monthly only. A day the month does not have means its last day.
  day_of_month smallint NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
  -- The Nairobi hour the payment goes.
  hour smallint NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
  weekend_rule text NOT NULL DEFAULT 'on_day' CHECK (weekend_rule IN ('on_day','before','skip')),
  -- The Safaricom command a phone line is sent with; business lines use the paybill or till command.
  phone_command text NOT NULL DEFAULT 'SalaryPayment' CHECK (phone_command IN ('SalaryPayment','BusinessPayment')),
  start_on date NOT NULL,
  end_on date CHECK (end_on IS NULL OR end_on >= start_on),
  -- active pays; paused keeps everything and pays nothing; stopped keeps the history and never pays
  -- again; finished is a schedule whose end date has passed.
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','stopped','finished')),
  -- The nominal date of the next payment not yet made, or null when there is none to come.
  next_due_on date,
  consented_by uuid REFERENCES people(id) ON DELETE SET NULL,
  consented_at timestamptz NOT NULL,
  created_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  stopped_by uuid REFERENCES people(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS schedules_org_idx ON schedules(org_id, created_at DESC);
-- What the scheduler asks for every minute.
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(next_due_on) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS schedule_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents % 100 = 0),
  note text CHECK (note IS NULL OR char_length(note) <= 100),
  position smallint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS schedule_lines_schedule_idx ON schedule_lines(schedule_id, position);

CREATE TABLE IF NOT EXISTS pay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  -- The nominal date this run is for; pay_on is the day the money went.
  due_on date NOT NULL,
  pay_on date NOT NULL,
  -- prepared: written, nothing sent yet. sending: every line handed to Safaricom, answers pending.
  -- done: every line paid. partly_failed / failed: some or all lines failed. refused: the float
  -- could not cover the run, so nobody was paid. missed: Studio was not running for days around
  -- the date, so it was not paid late on its own; the owner decides.
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','sending','done','partly_failed','failed','refused','missed')),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  line_count integer NOT NULL DEFAULT 0,
  reason_code text,
  reason text,
  gap_cents bigint CHECK (gap_cents IS NULL OR gap_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pay_runs_schedule_due_uniq ON pay_runs(schedule_id, due_on);
CREATE INDEX IF NOT EXISTS pay_runs_org_idx ON pay_runs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pay_runs_live_idx ON pay_runs(state) WHERE state IN ('prepared','sending');

CREATE TABLE IF NOT EXISTS pay_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- The payee as it stood that day.
  payee_name text NOT NULL,
  payee_kind text NOT NULL CHECK (payee_kind IN ('phone','till','paybill')),
  destination text NOT NULL,
  account_reference text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  note text,
  position smallint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','sent','paid','failed','unknown')),
  failure text,
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS pay_run_lines_run_idx ON pay_run_lines(run_id, position);
CREATE INDEX IF NOT EXISTS pay_run_lines_request_idx ON pay_run_lines(request_id) WHERE request_id IS NOT NULL;

ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON schedules;
CREATE POLICY org_isolation ON schedules USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE schedule_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON schedule_lines;
CREATE POLICY org_isolation ON schedule_lines USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON pay_runs;
CREATE POLICY org_isolation ON pay_runs USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE pay_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_run_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON pay_run_lines;
CREATE POLICY org_isolation ON pay_run_lines USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE schedules, schedule_lines, pay_runs, pay_run_lines TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant scheduled payment privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
