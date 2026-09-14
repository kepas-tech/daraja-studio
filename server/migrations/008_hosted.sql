-- Phase 3B: the schema hosted sign-up needs, and the grant narrowing that stops an organisation
-- promoting itself. Every statement is guarded, so running this file again changes nothing.

-- 007 put FORCE ROW LEVEL SECURITY on people and orgs, which applies to the table owner too.
-- Announce ourselves as the system so the backfill below can see its own rows on a database whose
-- owner is not a superuser. Transaction-local; migrate() wraps this file in one transaction.
SELECT set_config('app.role', 'system', true);

-- One organisation per Daraja app, per environment (spec 4.4). 007 deliberately left this index
-- out: nothing writes env.<e>.consumerKeyHash until POST /api/signup/daraja, which lands beside it.
CREATE UNIQUE INDEX IF NOT EXISTS settings_consumer_key_uniq
  ON settings(key, value)
  WHERE key IN ('env.sandbox.consumerKeyHash', 'env.production.consumerKeyHash');

-- orgs.create() inserts a row before it can derive that organisation's key, so the salt has to come
-- from the database rather than from the caller.
ALTER TABLE orgs ALTER COLUMN key_salt SET DEFAULT gen_random_bytes(32);

-- The hourly unverified-organisation sweep (spec 4.4) reads exactly these statuses by age.
CREATE INDEX IF NOT EXISTS orgs_unverified_idx ON orgs(created_at)
  WHERE status IN ('pending', 'creds_ok', 'operator_probing', 'failed');

-- The host organisation's owner is the first host admin (spec 6.1). Idempotent by the NOT clause;
-- a database with no host organisation matches nothing.
UPDATE people SET is_host_admin = true
 WHERE is_owner AND NOT is_host_admin
   AND org_id = (SELECT id FROM orgs WHERE is_host);

-- 007 granted studio_app SELECT, INSERT, UPDATE and DELETE on every table, orgs included. An
-- organisation may rename itself and move through its own status machine; it may never change its
-- slug, its callback secret or its key salt, make itself the host, or delete an organisation row.
--
-- INSERT stays. 007's org_self policy is WITH CHECK (app_is_system() OR id = app_current_org()), so
-- a request-context INSERT can only ever name the caller's own organisation id — a row that already
-- exists, which the primary key refuses. Creating an organisation is therefore a withSystem write on
-- this same role, and nothing at request time needs a privileged connection.
--
-- DELETE goes: closing an organisation keeps its row (spec 4.4), so the application never deletes
-- one, and neither should it be able to.
--
-- A managed PostgreSQL that refused 007's CREATE ROLE has no role to narrow; warn, do not abort.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      REVOKE UPDATE, DELETE ON orgs FROM studio_app;
      GRANT UPDATE (name, status, verified_at, fail_reason, suspend_reason, suspended_at) ON orgs TO studio_app;
      REVOKE ALL ON schema_migrations FROM studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'daraja-studio: could not narrow studio_app privileges (%).', SQLERRM;
    END;
  END IF;
END $$;
