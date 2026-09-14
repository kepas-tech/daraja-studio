import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPool, createAdminPool, withOrg, withSystem, resetContextForTests, type Db } from '../src/db/pool.js';
import { TEST_ORG_ID, ensureTestOrg, deleteOrg } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';
let app: Db;
let admin: Db;

beforeAll(async () => {
  app = createPool(url, { role: 'studio_app' });
  admin = createAdminPool(url);
  await ensureTestOrg(admin);
  // Every privileged write to a table under FORCE ROW LEVEL SECURITY goes through withSystem, so
  // the suite does not quietly depend on DATABASE_URL's user being a superuser (pre-flight S5).
  await withSystem(() =>
    admin.query(
      `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1, 'org-b', 'Second organisation', 'verified', false, 'hash-b', 'enc-b', gen_random_bytes(32))
       ON CONFLICT (id) DO NOTHING`,
      [ORG_B],
    ),
  );
});
afterAll(async () => {
  await deleteOrg(ORG_B);
  await app.end();
  await admin.end();
});
beforeEach(async () => {
  resetContextForTests();
  await withSystem(() => admin.query(`DELETE FROM settings WHERE key = 'org.name'`));
});

describe('row-level security', () => {
  it('the pooled connection is neither a superuser nor allowed to bypass RLS', async () => {
    const rows = await app.query<{ cur: string; su: boolean; bypass: boolean }>(
      `SELECT current_user AS cur,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
    );
    expect(rows[0]).toEqual({ cur: 'studio_app', su: false, bypass: false });
  });

  it('a query that forgets its WHERE returns only the current organisation\'s rows', async () => {
    await withOrg(TEST_ORG_ID, () => app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org one')`));
    await withOrg(ORG_B, () => app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org two')`));

    // Filtered on key: this shared test database runs dozens of other files against the same
    // organisation, each free to leave its own settings rows behind, so an unfiltered SELECT is
    // not a stable way to assert isolation — org.name is what this test itself controls.
    const one = await withOrg(TEST_ORG_ID, () => app.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'org.name'`));
    const two = await withOrg(ORG_B, () => app.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'org.name'`));
    expect(one).toEqual([{ value: 'Org one' }]);
    expect(two).toEqual([{ value: 'Org two' }]);
  });

  it('naming another organisation\'s id in a SELECT still returns zero rows', async () => {
    await withOrg(ORG_B, () => app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org two')`));
    const stolen = await withOrg(TEST_ORG_ID, () =>
      app.query(`SELECT value FROM settings WHERE org_id = $1`, [ORG_B]),
    );
    expect(stolen).toEqual([]);
  });

  it('an INSERT outside any organisation fails loudly, not silently', async () => {
    // org_id defaults to app_current_org(), which is NULL with no context in scope. PostgreSQL
    // evaluates the RLS WITH CHECK policy before the NOT NULL constraint, so a NULL org_id is
    // rejected by the policy (42501) rather than ever reaching the NOT NULL check (23502) — either
    // way, the write never lands with no organisation attached.
    await expect(app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'nowhere')`)).rejects.toMatchObject({
      code: '42501', // insufficient_privilege — RLS WITH CHECK
    });
  });

  it('an INSERT naming another organisation is refused by the policy', async () => {
    await expect(
      withOrg(TEST_ORG_ID, () =>
        app.query(`INSERT INTO settings(org_id, key, value) VALUES ($1, 'org.name', 'smuggled')`, [ORG_B]),
      ),
    ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege — RLS WITH CHECK
  });

  it('an UPDATE cannot move a row into another organisation', async () => {
    await withOrg(TEST_ORG_ID, () => app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org one')`));
    await expect(
      withOrg(TEST_ORG_ID, () => app.query(`UPDATE settings SET org_id = $1 WHERE key = 'org.name'`, [ORG_B])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('withSystem sees every organisation', async () => {
    await withOrg(TEST_ORG_ID, () => app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org one')`));
    await withOrg(ORG_B, () => app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org two')`));
    const all = await withSystem(() =>
      app.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'org.name' ORDER BY value`),
    );
    expect(all.map((r) => r.value)).toEqual(['Org one', 'Org two']);
  });

  it('an organisation sees its own row in orgs and nobody else\'s', async () => {
    const mine = await withOrg(ORG_B, () => app.query<{ slug: string }>('SELECT slug FROM orgs'));
    expect(mine).toEqual([{ slug: 'org-b' }]);
    const none = await app.query('SELECT slug FROM orgs');
    expect(none).toEqual([]);
  });

  it('every tenant table carries org_id, defaults it, and forces row-level security', async () => {
    const tables = ['settings', 'people', 'permissions', 'sessions', 'operators', 'requests', 'balances', 'callbacks_raw', 'audit_log'];
    const rows = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)`,
      [tables],
    );
    expect(rows).toHaveLength(tables.length);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);

    const cols = await admin.query<{ table_name: string; is_nullable: string; column_default: string }>(
      `SELECT table_name, is_nullable, column_default FROM information_schema.columns
        WHERE column_name = 'org_id' AND table_name = ANY($1)`,
      [tables],
    );
    expect(cols).toHaveLength(tables.length);
    for (const c of cols) {
      expect(c.is_nullable).toBe('NO');
      expect(c.column_default).toContain('app_current_org()');
    }
  });

  it('the fallback organisation makes context-free code behave exactly as it does in single mode', async () => {
    app.setFallbackOrg(TEST_ORG_ID);
    try {
      await app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org one')`);
      const rows = await app.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'org.name'`);
      expect(rows).toEqual([{ value: 'Org one' }]);
    } finally {
      app.setFallbackOrg(null);
    }
  });

  it('with no fallback — hosted mode — context-free code sees nothing at all', async () => {
    await withOrg(TEST_ORG_ID, () => app.query(`INSERT INTO settings(key, value) VALUES ('org.name', 'Org one')`));
    expect(await app.query(`SELECT value FROM settings`)).toEqual([]);
  });
});
