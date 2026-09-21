import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminPool, withOrg, withSystem, resetContextForTests, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ensureTestOrg } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: Db;
let preDir: string;

/**
 * Migration 047, the one that lets a webhook address belong to a key.
 *
 * The state under test is the one every live install is in when it upgrades: migrations through 046
 * have run, the organisation has its one address, and every delivery that exists was written for
 * that address. The migration has to leave all of it where it is — the organisation's address stays
 * the organisation's, and the deliveries point at it — while letting a key hold one of its own.
 */
beforeAll(async () => {
  db = createAdminPool(url);
  preDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-047-'));
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql') && f < '047_');
  for (const f of files) await fs.copyFile(path.join(migrationsDir, f), path.join(preDir, f));
});

afterAll(async () => {
  resetContextForTests();
  await ensureTestOrg(db);
  await db.end();
  await fs.rm(preDir, { recursive: true, force: true });
});

async function upTo046(): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, preDir);
}

/** An organisation with an owner, a key and the one address a delivery was written for. */
async function seed(slug: string): Promise<{ orgId: string; keyId: string; hookId: string }> {
  const [org] = await withSystem(() =>
    db.query<{ id: string }>(
      `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1, $1, 'verified', true, $2, 'unset', gen_random_bytes(32)) RETURNING id`,
      [slug, 'hash-' + slug],
    ),
  );
  const orgId = org!.id;
  await withOrg(orgId, () =>
    db.query(`INSERT INTO people(username, display_name, password_hash, is_owner, is_host_admin) VALUES ($1, $1, 'h', true, true)`, [slug + '-owner']),
  );
  const [key] = await withOrg(orgId, () =>
    db.query<{ id: string }>(
      `INSERT INTO api_keys(name, prefix, key_hash, role, created_by)
       VALUES ('A system', $1, 'h', 'collector', (SELECT id FROM people LIMIT 1)) RETURNING id`,
      [(slug + '000000000000').slice(0, 12)],
    ),
  );
  const [hook] = await withOrg(orgId, () =>
    db.query<{ id: string }>(
      `INSERT INTO webhooks(org_id, url, secret_enc, secret_hint, created_by)
       VALUES ($1, 'https://example.test/hooks/org', 'enc', 'abcd', (SELECT id FROM people LIMIT 1)) RETURNING id`,
      [orgId],
    ),
  );
  await withOrg(orgId, () =>
    db.query(`INSERT INTO webhook_deliveries(event, url, payload) VALUES ('request.completed', 'https://example.test/hooks/org', '{}'::jsonb)`),
  );
  return { orgId, keyId: key!.id, hookId: hook!.id };
}

const addresses = async () => withSystem(() =>
  db.query<{ api_key_id: string | null; url: string }>('SELECT api_key_id, url FROM webhooks ORDER BY url'));

describe('migration 047', () => {
  it('leaves the organisation address its own, points existing deliveries at it, and lets a key have one', async () => {
    await upTo046();
    const { orgId, keyId, hookId } = await seed('kepas');

    const applied = await migrate(db, migrationsDir);
    expect(applied[0]).toBe('047');

    // The organisation's address is still the organisation's, and the delivery that predates the
    // migration now names it.
    expect(await addresses()).toEqual([{ api_key_id: null, url: 'https://example.test/hooks/org' }]);
    const [delivery] = await withSystem(() =>
      db.query<{ webhook_id: string | null; url: string }>('SELECT webhook_id, url FROM webhook_deliveries'));
    expect(delivery!.webhook_id).toBe(hookId);
    expect(delivery!.url).toBe('https://example.test/hooks/org');

    // A key can hold one of its own: one each, and the organisation still only one.
    await withOrg(orgId, () =>
      db.query(
        `INSERT INTO webhooks(org_id, api_key_id, url, secret_enc, secret_hint) VALUES ($1, $2, 'https://example.test/hooks/key', 'enc2', 'efgh')`,
        [orgId, keyId],
      ),
    );
    expect(await addresses()).toEqual([
      { api_key_id: keyId, url: 'https://example.test/hooks/key' },
      { api_key_id: null, url: 'https://example.test/hooks/org' },
    ]);
    await expect(withOrg(orgId, () =>
      db.query(`INSERT INTO webhooks(org_id, api_key_id, url, secret_enc, secret_hint) VALUES ($1, $2, 'https://example.test/hooks/two', 'e', 'f')`, [orgId, keyId]),
    )).rejects.toThrow();
    await expect(withOrg(orgId, () =>
      db.query(`INSERT INTO webhooks(org_id, url, secret_enc, secret_hint) VALUES ($1, 'https://example.test/hooks/org2', 'e', 'f')`, [orgId]),
    )).rejects.toThrow();
  }, 60_000);

  it('changes nothing more the second time', async () => {
    await upTo046();
    const { hookId } = await seed('kepas');
    expect(await migrate(db, migrationsDir)).toContain('047');

    // Nothing left to apply, and the rows are exactly as the first run left them.
    expect(await migrate(db, migrationsDir)).toEqual([]);
    expect(await addresses()).toEqual([{ api_key_id: null, url: 'https://example.test/hooks/org' }]);
    const [delivery] = await withSystem(() => db.query<{ webhook_id: string | null }>('SELECT webhook_id FROM webhook_deliveries'));
    expect(delivery!.webhook_id).toBe(hookId);
  }, 60_000);
});
