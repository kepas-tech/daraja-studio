import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { withSystem, resetContextForTests } from '../src/db/pool.js';
import { DEFAULT_ORG_NAME } from '../src/orgs/service.js';
import { makeApp, resetTables, ensureTestOrg, deleteOrg, TEST_ORG_ID } from './helpers.js';

/**
 * The install's own name, as anybody can see it.
 *
 * The login screen has nobody signed in and no organisation to name, so the one name it may show is
 * the install's: the host organisation's own. These tests hold it to that — the name once the install
 * has one, nothing at all while it still carries the name it starts life with, and never a tenant's.
 */
const studio = makeApp();

afterAll(async () => {
  await studio.close();
  resetContextForTests();
});

beforeEach(async () => {
  await resetTables();
  await ensureTestOrg();
});

const status = async () => (await request(studio.app).get('/api/setup/status')).body as { studioName?: string | null };
const rename = (id: string, name: string) =>
  withSystem(() => studio.deps.db.query('UPDATE orgs SET name = $2 WHERE id = $1', [id, name]));

describe('the studio name on the login screen', () => {
  it('is the host organisation own name, once the install has one', async () => {
    await rename(TEST_ORG_ID, 'KEPAS TECHNOLOGIES');
    expect((await status()).studioName).toBe('KEPAS TECHNOLOGIES');
  });

  it('is nothing at all while the install still has the name it starts with', async () => {
    // The boot pass names organisation #1 before anybody has named it. That is not a name it has, and
    // the login screen must not read as though it were.
    await rename(TEST_ORG_ID, DEFAULT_ORG_NAME);
    expect((await status()).studioName).toBeNull();
  });

  it('is never a tenant own name, even when a tenant is right there', async () => {
    await rename(TEST_ORG_ID, 'KEPAS TECHNOLOGIES');
    const [tenant] = await withSystem(() =>
      studio.deps.db.query<{ id: string }>(
        `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ('a-tenant','Demo Tenant','verified',false,'hash-tenant','unset',gen_random_bytes(32)) RETURNING id`,
      ),
    );
    try {
      const body = await status();
      expect(body.studioName).toBe('KEPAS TECHNOLOGIES');
      // Nothing in the answer is the tenant's: not the name, not the id, nothing.
      expect(JSON.stringify(body)).not.toContain('Demo Tenant');
      expect(JSON.stringify(body)).not.toContain(tenant!.id);
    } finally {
      await deleteOrg(tenant!.id);
    }
  });
});
