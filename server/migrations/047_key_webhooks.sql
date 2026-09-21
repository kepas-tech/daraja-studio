-- Step six, part five: a webhook address may belong to a key, not only to the organisation.
--
-- The organisation keeps its one address exactly as it always had it: the row whose api_key_id is
-- NULL, the default every notice falls back to. A key that is given its own address gets a second
-- row naming it, with its own signing secret, and notices for the payments that key asked for go
-- there and nowhere else.

ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS api_key_id uuid REFERENCES api_keys(id) ON DELETE CASCADE;

-- One address per organisation (the default), and one per key (its own). The old index allowed
-- exactly one row per organisation; the two partial indexes below say the same thing and add the
-- key's own.
DROP INDEX IF EXISTS webhooks_one_per_org;
CREATE UNIQUE INDEX IF NOT EXISTS webhooks_one_per_org ON webhooks(org_id) WHERE api_key_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS webhooks_one_per_key ON webhooks(api_key_id) WHERE api_key_id IS NOT NULL;

-- A delivery names the address it was written for, so a queued notice keeps its own receiver and its
-- own secret even after the address changes or a key is stopped. Every delivery written before this
-- migration was written for its organisation's one address, and that is what it is backfilled to.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS webhook_id uuid REFERENCES webhooks(id) ON DELETE SET NULL;

UPDATE webhook_deliveries d SET webhook_id = w.id
  FROM webhooks w
 WHERE w.org_id = d.org_id AND w.api_key_id IS NULL AND d.webhook_id IS NULL;

CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries(webhook_id);
