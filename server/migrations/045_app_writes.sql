-- 045: what a machine calling this studio needs, and none of it is about any one caller.
--
-- Three facts and one store, all generic: a caller's own reference on a request, the key that made a
-- request when no person did, and an idempotency key so a retry after a timeout gets the first answer
-- rather than a second payment. The Stripe shape is deliberate — same header, same replay answer,
-- same twenty-four hours — because that is the shape an integration already knows.

-- 1. The caller's own reference: opaque, one string, echoed back in the webhook. It is NOT the
-- account reference, which is how money finds a business and an account on this studio; an
-- application's own id there would fight that routing and manufacture unmatched payments.
-- 64 characters is the ceiling: long enough for a uuid, an order number or a composite key, short
-- enough that nobody is tempted to put a document in it.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS caller_ref text
  CHECK (caller_ref IS NULL OR (char_length(caller_ref) BETWEEN 1 AND 64));

-- 2. Who made this request, when no person did. The person column stays what it says — a person —
-- and an API key gets its own column rather than a foreign key that would point at the wrong table.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;

-- 3. The idempotency store. Scope is the route, so the same key on two different writes is two
-- different requests, which is what a caller expects; the organisation scopes it as everything else
-- does. Status 0 means claimed and still running: a second call with the same key while the first is
-- in flight is refused rather than run, and a claim older than a minute is treated as abandoned and
-- taken over, so a process that died mid-request cannot hold a key for a day.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT app_current_org() REFERENCES orgs(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 120),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  status smallint NOT NULL DEFAULT 0,
  body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE UNIQUE INDEX IF NOT EXISTS idempotency_keys_org_scope_key ON idempotency_keys(org_id, scope, key);
CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys(expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON idempotency_keys;
CREATE POLICY org_isolation ON idempotency_keys USING (app_is_system() OR org_id = app_current_org())
  WITH CHECK (app_is_system() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
    BEGIN
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE idempotency_keys TO studio_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not grant idempotency_keys privileges to studio_app: %', SQLERRM;
    END;
  END IF;
END $$;
