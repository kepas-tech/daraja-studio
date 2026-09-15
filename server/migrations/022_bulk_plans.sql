-- Bulk send (M5): a batch is bookkeeping over ordinary request rows. The plan holds the validated
-- rows and, per row, the outcome once the drain job has sent it through the same path a single
-- send takes. requests.bulk_plan_id (001) points back here.
CREATE TABLE IF NOT EXISTS bulk_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  created_by uuid REFERENCES people(id),
  category text,
  row_count int NOT NULL,
  total_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','done','partly_done')),
  rows jsonb NOT NULL,
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS bulk_plans_org_created_idx ON bulk_plans(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_bulk_plan_idx ON requests(bulk_plan_id) WHERE bulk_plan_id IS NOT NULL;

ALTER TABLE bulk_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON bulk_plans;
CREATE POLICY org_isolation ON bulk_plans USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bulk_plans TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant bulk_plans privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
