-- Businesses and customers (feature 2). One paybill, several businesses: the payer's account
-- number starts with a three-digit business code (000-999) followed by a customer number Studio
-- minted for that business, so 000123 is business 000, customer 123. A business is switched off,
-- never deleted, so a code is never reused and an old account number keeps meaning what it meant;
-- a customer is retired softly and its number is never reused. Item 7 (free-text account names) is
-- replaced by this table: the label is the customer's name and the numbers are digits only.
CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  code char(3) NOT NULL CHECK (code ~ '^[0-9]{3}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS businesses_org_code_uniq ON businesses(org_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS businesses_org_name_uniq ON businesses(org_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number >= 0),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  phone text CHECK (phone IS NULL OR phone ~ '^254[0-9]{9}$'),
  note text CHECK (note IS NULL OR char_length(note) <= 200),
  created_by uuid REFERENCES people(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
-- The number is unique per business across live AND retired rows: retiring a customer never frees
-- its number for reuse, so an account number a payer already has keeps its meaning.
CREATE UNIQUE INDEX IF NOT EXISTS customers_business_number_uniq ON customers(business_id, number);
CREATE INDEX IF NOT EXISTS customers_org_business_idx ON customers(org_id, business_id) WHERE deleted_at IS NULL;

-- Which business (and customer) a money row belongs to. C2B rows get this from the account number
-- at write time; money-out rows carry the operator's own choice. SET NULL on delete is belt and
-- braces: neither side is ever hard-deleted while an organisation lives.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS requests_business_idx ON requests(business_id) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_customer_idx ON requests(customer_id) WHERE customer_id IS NOT NULL;

-- A batch is sent under one business, the same way a single send is.
ALTER TABLE bulk_plans ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON businesses;
CREATE POLICY org_isolation ON businesses USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON customers;
CREATE POLICY org_isolation ON customers USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE businesses, customers TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant businesses/customers privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
