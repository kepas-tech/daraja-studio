-- Step three of nine: sweep-through. Money arrives under a business's account numbers and leaves
-- the same day, to that business's own phone, on the timetable it chose, less the fee set for it.
--
-- Nothing here writes a balance. What is owed to a business is always a sum over rows: payments in,
-- less the sweeps already sent or in flight, less the fees taken. It is worked out on demand, so no
-- figure can drift from the payments that make it up, and there is no row anywhere that says "the
-- balance is X".
--
-- Three tables:
--   sweep_settings  one row per business: where the money goes, when, and what is kept.
--   sweeps          one row per business per window. UNIQUE (business_id, window) is what makes a
--                   retry, a restart, two schedulers or a clock slip unable to pay twice.
--   sweep_payments  the payment rows a sweep covers, so every shilling that left is traceable to
--                   the shillings that arrived. A payment may appear under more than one sweep: a
--                   held or failed window's money is carried by the next one. That is why the pair
--                   is the key and the payment alone is not.

CREATE TABLE IF NOT EXISTS sweep_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Null means this business has no phone to sweep to. It then never sweeps, and its page says so.
  -- Stored the way Safaricom wants it: 254 followed by nine digits.
  destination_phone text CHECK (destination_phone IS NULL OR destination_phone ~ '^254[0-9]{9}$'),
  schedule text NOT NULL DEFAULT 'arrival' CHECK (schedule IN ('arrival','daily','weekly')),
  -- The hour a daily sweep is due, on the Nairobi clock. Unused by the other two timetables.
  hour smallint NOT NULL DEFAULT 20 CHECK (hour BETWEEN 0 AND 23),
  -- 0 is Monday, which is how a Kenyan week is read and what ISO numbers too.
  weekday smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  -- The fee, set per business: a percentage, a flat amount, or both, with a floor and a ceiling.
  -- 100 basis points is one per cent. Null floor or ceiling means there is none.
  fee_percent_bp integer NOT NULL DEFAULT 0 CHECK (fee_percent_bp BETWEEN 0 AND 10000),
  fee_flat_cents bigint NOT NULL DEFAULT 0 CHECK (fee_flat_cents >= 0),
  fee_floor_cents bigint CHECK (fee_floor_cents IS NULL OR fee_floor_cents >= 0),
  fee_ceiling_cents bigint CHECK (fee_ceiling_cents IS NULL OR fee_ceiling_cents >= 0),
  -- One press stops it. The money stays owed and visible; nothing is sent while this is true.
  stopped boolean NOT NULL DEFAULT false,
  -- Consented once, when the destination and the timetable were first saved. Later changes to either
  -- need the owner's step-up and write an audit row; the consent itself is never rewritten.
  consented_at timestamptz,
  consented_by uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sweep_settings_business_uniq ON sweep_settings(business_id);
CREATE INDEX IF NOT EXISTS sweep_settings_org_idx ON sweep_settings(org_id);

CREATE TABLE IF NOT EXISTS sweeps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- The window this sweep is for, written as text so two servers with two clocks still agree on it:
  -- 'arrival:2026-09-19T18:05', 'daily:2026-09-19' or 'weekly:2026-09-14' (the Monday itself).
  -- Named window_key because `window` is SQL's own word, and a column that has to be quoted in
  -- every statement is a column somebody will one day forget to quote.
  window_key text NOT NULL,
  schedule text NOT NULL CHECK (schedule IN ('arrival','daily','weekly')),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared','sending','sent','failed','held')),
  gross_cents bigint NOT NULL DEFAULT 0 CHECK (gross_cents >= 0),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  net_cents bigint NOT NULL DEFAULT 0 CHECK (net_cents >= 0),
  -- Where it was sent, kept on the row: changing the phone later never rewrites where an old sweep
  -- went, and the receipt beside it is the proof it arrived.
  destination_phone text,
  -- Why it did not go, in a code for the software and in the owner's own words for the page.
  reason_code text,
  reason text,
  -- How short the float was, when that is the reason. Named, never guessed at later.
  gap_cents bigint CHECK (gap_cents IS NULL OR gap_cents >= 0),
  -- The ordinary money-out row that carried it, once one exists.
  request_id uuid REFERENCES requests(id) ON DELETE SET NULL,
  receipt text,
  sent_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sweeps_business_window_uniq ON sweeps(business_id, window_key);
CREATE INDEX IF NOT EXISTS sweeps_org_business_idx ON sweeps(org_id, business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sweeps_request_idx ON sweeps(request_id) WHERE request_id IS NOT NULL;
-- What the scheduler asks for every minute: the sweeps still waiting on an answer.
CREATE INDEX IF NOT EXISTS sweeps_live_idx ON sweeps(state) WHERE state IN ('prepared','sending');

CREATE TABLE IF NOT EXISTS sweep_payments (
  sweep_id uuid NOT NULL REFERENCES sweeps(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (sweep_id, request_id)
);
CREATE INDEX IF NOT EXISTS sweep_payments_request_idx ON sweep_payments(request_id);

ALTER TABLE sweep_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON sweep_settings;
CREATE POLICY org_isolation ON sweep_settings USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE sweeps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweeps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON sweeps;
CREATE POLICY org_isolation ON sweeps USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE sweep_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sweep_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON sweep_payments;
CREATE POLICY org_isolation ON sweep_payments USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sweep_settings, sweeps, sweep_payments TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant sweep privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
