-- Safaricom's charge per row (feature 11). The public Customer Bouquet PayBill (C2B) and
-- Disbursement (B2C) tariff bands, read from KEPAS Pay's own migrations/018_safaricom_fees.sql on
-- the VPS; B2B is the same as B2C there and here. Display only: Studio adds no fee of its own, so
-- there is no margin anywhere in this feature. Charges are whole shillings; the table keeps cents,
-- like every other amount in Studio, so KES 5 is 500.
CREATE TABLE IF NOT EXISTS safaricom_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('c2b','b2c','b2b')),
  min_cents bigint NOT NULL CHECK (min_cents >= 0),
  max_cents bigint NOT NULL CHECK (max_cents >= min_cents),
  charge_cents bigint NOT NULL CHECK (charge_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT safaricom_fees_org_kind_min_uniq UNIQUE (org_id, kind, min_cents)
);
CREATE INDEX IF NOT EXISTS safaricom_fees_lookup_idx ON safaricom_fees(org_id, kind, min_cents, max_cents);

-- What the band said when the row was written, so a later tariff change never rewrites what an old
-- payment cost. NULL on every row written before this feature, and on an amount with no band.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS charge_cents bigint;

ALTER TABLE safaricom_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE safaricom_fees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON safaricom_fees;
CREATE POLICY org_isolation ON safaricom_fees USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE safaricom_fees TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant safaricom_fees privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;

-- The published bands, seeded once for every organisation that exists now. An organisation created
-- after this migration is seeded the first time its bands are read (server/src/fees/service.ts),
-- from the same numbers. An organisation that already has bands of its own is left exactly as it
-- is: this runs at migration time only, and it never overwrites an edit.
DO $$
DECLARE
  o uuid;
BEGIN
  -- The application's own system context, so the seed works whether or not this connection is a
  -- superuser (both tables are FORCE ROW LEVEL SECURITY). Transaction-local, and put back before
  -- the migration ends: migrate() runs every pending file in one transaction.
  PERFORM set_config('app.role', 'system', true);
  PERFORM set_config('app.org_id', '', true);

  FOR o IN SELECT id FROM orgs LOOP
    IF NOT EXISTS (SELECT 1 FROM safaricom_fees WHERE org_id = o) THEN
      INSERT INTO safaricom_fees(org_id, kind, min_cents, max_cents, charge_cents)
      SELECT o, v.kind, v.min_cents, v.max_cents, v.charge_cents
        FROM (VALUES
          ('c2b', 100, 4900, 0),
          ('c2b', 5000, 10000, 0),
          ('c2b', 10100, 50000, 500),
          ('c2b', 50100, 100000, 1000),
          ('c2b', 100100, 150000, 1500),
          ('c2b', 150100, 250000, 2000),
          ('c2b', 250100, 350000, 2500),
          ('c2b', 350100, 500000, 3400),
          ('c2b', 500100, 750000, 4500),
          ('c2b', 750100, 1000000, 5500),
          ('c2b', 1000100, 1500000, 7000),
          ('c2b', 1500100, 2000000, 9000),
          ('c2b', 2000100, 2500000, 10000),
          ('c2b', 2500100, 3500000, 12000),
          ('c2b', 3500100, 5000000, 15000),
          ('c2b', 5000100, 7000000, 18000),
          ('c2b', 7000100, 15000000, 25000),
          ('b2c', 100, 4900, 0),
          ('b2c', 5000, 10000, 0),
          ('b2c', 10100, 50000, 700),
          ('b2c', 50100, 100000, 1300),
          ('b2c', 100100, 150000, 2300),
          ('b2c', 150100, 250000, 3300),
          ('b2c', 250100, 350000, 5600),
          ('b2c', 350100, 500000, 5700),
          ('b2c', 500100, 750000, 7000),
          ('b2c', 750100, 1000000, 9000),
          ('b2c', 1000100, 1500000, 11000),
          ('b2c', 1500100, 2000000, 13000),
          ('b2c', 2000100, 2500000, 15000),
          ('b2c', 2500100, 3500000, 17500),
          ('b2c', 3500100, 5000000, 20000),
          ('b2c', 5000100, 7000000, 25000),
          ('b2c', 7000100, 15000000, 33000),
          ('b2b', 100, 4900, 0),
          ('b2b', 5000, 10000, 0),
          ('b2b', 10100, 50000, 700),
          ('b2b', 50100, 100000, 1300),
          ('b2b', 100100, 150000, 2300),
          ('b2b', 150100, 250000, 3300),
          ('b2b', 250100, 350000, 5600),
          ('b2b', 350100, 500000, 5700),
          ('b2b', 500100, 750000, 7000),
          ('b2b', 750100, 1000000, 9000),
          ('b2b', 1000100, 1500000, 11000),
          ('b2b', 1500100, 2000000, 13000),
          ('b2b', 2000100, 2500000, 15000),
          ('b2b', 2500100, 3500000, 17500),
          ('b2b', 3500100, 5000000, 20000),
          ('b2b', 5000100, 7000000, 25000),
          ('b2b', 7000100, 15000000, 33000)
        ) AS v(kind, min_cents, max_cents, charge_cents)
       WHERE NOT EXISTS (SELECT 1 FROM safaricom_fees f WHERE f.org_id = o AND f.kind = v.kind);
    END IF;
  END LOOP;

  PERFORM set_config('app.role', '', true);
END $$;
