import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createAdminPool, withOrg, withSystem, type Db } from '../src/db/pool.js';
import { createDarajaFactory } from '../src/sdk/client.js';
import { sha256 } from '../src/crypto/secrets.js';
import { testDeps, resetTables, deleteOrg, TEST_ORG_ID } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const ORG_D = '00000000-0000-4000-8000-0000000000d1';
const admin: Db = createAdminPool(url);
const deps = testDeps();

afterAll(async () => {
  await deleteOrg(ORG_D);
  await admin.end();
  await deps.db.end();
});

beforeEach(async () => {
  await resetTables(deps.db);
  await withSystem(() =>
    admin.query(
      `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1,'org-d1','Org D','verified',false,$2,'unset',gen_random_bytes(32))
       ON CONFLICT (id) DO UPDATE SET status='verified'`,
      [ORG_D, sha256('org-d-secret')],
    ),
  );
});

/** Verified sandbox creds for one organisation, distinguishable by shortcode/consumerKey. */
async function setupEnv(orgId: string, shortcode: string, consumerKey: string) {
  await withOrg(orgId, async () => {
    await deps.settings.set('daraja.environment', 'sandbox');
    await deps.settings.set('env.sandbox.shortcode', shortcode);
    await deps.settings.set('env.sandbox.consumerKey', consumerKey);
    await deps.settings.set('env.sandbox.consumerSecret', 's');
    await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
  });
}

describe('per-organisation Daraja client isolation (spec §10.8)', () => {
  it('a client built under one organisation is never handed to another', async () => {
    await setupEnv(TEST_ORG_ID, '600001', 'key-one');
    await setupEnv(ORG_D, '600002', 'key-two');
    const f = createDarajaFactory({ ...deps });

    const a = await withOrg(TEST_ORG_ID, () => f.get());
    const b = await withOrg(ORG_D, () => f.get());
    expect(a.config.shortcode).toBe('600001');
    expect(a.config.consumerKey).toBe('key-one');
    expect(b.config.shortcode).toBe('600002');
    expect(b.config.consumerKey).toBe('key-two');

    // Asking again under each organisation returns that same organisation's cached instance —
    // never the other one's.
    expect(await withOrg(TEST_ORG_ID, () => f.get())).toBe(a);
    expect(await withOrg(ORG_D, () => f.get())).toBe(b);
  });

  it('evicts the oldest cached organisation once the client cache is full', async () => {
    await setupEnv(TEST_ORG_ID, '600001', 'key-one');
    await setupEnv(ORG_D, '600002', 'key-two');
    const f = createDarajaFactory({ ...deps, maxCachedClients: 1 });

    const first = await withOrg(TEST_ORG_ID, () => f.get());
    const second = await withOrg(ORG_D, () => f.get()); // over the cap of 1 — evicts TEST_ORG_ID
    expect(await withOrg(ORG_D, () => f.get())).toBe(second); // still cached, no rebuild

    const rebuilt = await withOrg(TEST_ORG_ID, () => f.get()); // evicted — must rebuild
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.config.shortcode).toBe('600001');
  });

  it('forOrg(orgId) builds outside any request context, and invalidate(orgId) forgets only that organisation', async () => {
    await setupEnv(TEST_ORG_ID, '600001', 'key-one');
    await setupEnv(ORG_D, '600002', 'key-two');
    const f = createDarajaFactory({ ...deps });

    const mineBefore = await withOrg(TEST_ORG_ID, () => f.get());
    const bound = f.forOrg(ORG_D);
    // No withOrg wrapper around this call: testDeps()'s own fallback is TEST_ORG_ID, not ORG_D —
    // forOrg must switch into ORG_D's context itself rather than relying on whatever is ambient.
    const theirs = await bound.get();
    expect(theirs.config.shortcode).toBe('600002');

    f.invalidate(ORG_D);
    const theirsRebuilt = await bound.get();
    expect(theirsRebuilt).not.toBe(theirs);
    expect(theirsRebuilt.config.shortcode).toBe('600002');

    // Narrow: invalidating ORG_D must never touch TEST_ORG_ID's own cached client.
    const mineAfter = await withOrg(TEST_ORG_ID, () => f.get());
    expect(mineAfter).toBe(mineBefore);
  });
});
