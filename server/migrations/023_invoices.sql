-- Invoices (M7, Safaricom Bill Manager). One row per invoice this studio sent; payments arrive as
-- requests rows of type invoice_payment (payload_json.invoiceId points here) so they show in History.
-- Named customer_invoices: an install migrated from the hosted line already has an `invoices` table
-- (013_invoices.sql, the host's own billing), and a same-named CREATE IF NOT EXISTS would silently
-- skip and leave the indexes to fail the boot.
CREATE TABLE IF NOT EXISTS customer_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  seq int NOT NULL,
  external_reference text NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  invoice_name text NOT NULL,
  account_reference text NOT NULL,
  billed_period text NOT NULL,
  due_date date NOT NULL,
  amount_cents bigint NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','partly_paid','paid','cancelled')),
  paid_cents bigint NOT NULL DEFAULT 0,
  created_by uuid REFERENCES people(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_invoices_org_seq_uniq ON customer_invoices(org_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS customer_invoices_org_ref_uniq ON customer_invoices(org_id, external_reference);
CREATE INDEX IF NOT EXISTS customer_invoices_org_account_idx ON customer_invoices(org_id, account_reference) WHERE status IN ('sent','partly_paid');

ALTER TABLE customer_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON customer_invoices;
CREATE POLICY org_isolation ON customer_invoices USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_invoices TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant customer_invoices privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
