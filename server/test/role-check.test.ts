import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createPool, createAdminPool, type Db } from '../src/db/pool.js';
import { checkDbRole, assertDbRole, assumeAppRole } from '../src/boot/roleCheck.js';
import { ensureStudioAppRole } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const pools: Db[] = [];
function track(db: Db) {
  pools.push(db);
  return db;
}
afterAll(async () => {
  for (const p of pools) await p.end();
});

beforeAll(async () => {
  await ensureStudioAppRole(track(createAdminPool(url)));
});

describe('checkDbRole', () => {
  it('passes for a pool that assumed studio_app', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    expect(await checkDbRole(db)).toBeNull();
  });

  it('treats a login-capable studio_app with clean flags as ok, never asking it to grant itself to itself', async () => {
    const admin = track(createAdminPool(url));
    // SET LOCAL, not SET, and SESSION AUTHORIZATION (not ROLE): it changes current_user AND
    // session_user together — simulating a real login as studio_app without giving the shared
    // role LOGIN, and it reverts automatically when the transaction commits.
    const probe: Db = {
      ...admin,
      query: async <T>(sql: string, params: unknown[] = []) =>
        admin.tx(async (c) => {
          await c.query('SET LOCAL SESSION AUTHORIZATION studio_app');
          return (await c.query(sql, params)).rows as T[];
        }),
    };
    expect(await checkDbRole(probe)).toBeNull();
  });

  it('names the exact statements an administrator must run when the role was not assumed', async () => {
    const db = track(createAdminPool(url));
    const problem = await checkDbRole(db);
    expect(problem).toContain('studio_app');
    expect(problem).toContain('CREATE ROLE studio_app NOLOGIN NOBYPASSRLS;');
    expect(problem).toContain('GRANT studio_app TO');
    // Plain English first: no SQLSTATE, no stack, no jargon in the opening sentence.
    expect(problem!.split('\n')[0]).toMatch(/must connect to PostgreSQL as/);
  });

  it('reports a role that has DELETE on orgs, as a hand re-run of 007 alone would leave it', async () => {
    const admin = track(createAdminPool(url));
    const db = track(createPool(url, { role: 'studio_app' }));
    await admin.query('GRANT DELETE ON orgs TO studio_app');
    try {
      const problem = await checkDbRole(db);
      expect(problem).toContain('The database role studio_app can delete organisations.');
      expect(problem).toContain('REVOKE DELETE ON orgs FROM studio_app;');
    } finally {
      await admin.query('REVOKE DELETE ON orgs FROM studio_app');
    }
  });

  it('reports a role that bypasses row-level security', async () => {
    const admin = track(createAdminPool(url));
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_bypass') THEN
        CREATE ROLE studio_bypass NOLOGIN BYPASSRLS;
      END IF;
    END $$`);
    await admin.query('GRANT studio_bypass TO CURRENT_USER');
    // SET LOCAL, not SET ROLE: it must revert when the transaction commits, or the pooled
    // connection stays stuck as studio_bypass and the REVOKE below fails with permission denied.
    const rows = await admin.tx(async (c) => {
      await c.query('SET LOCAL ROLE studio_bypass');
      return (await c.query('SELECT current_user AS cur')).rows;
    });
    expect(rows[0].cur).toBe('studio_bypass');
    // checkDbRole reads the pooled connection, so drive it through a pool that assumes the role.
    const probe: Db = {
      ...admin,
      query: async <T>(sql: string, params: unknown[] = []) =>
        admin.tx(async (c) => {
          await c.query('SET LOCAL ROLE studio_bypass');
          return (await c.query(sql, params)).rows as T[];
        }),
    };
    const problem = await checkDbRole(probe);
    expect(problem).toContain('BYPASSRLS');
    expect(problem).toContain('ALTER ROLE studio_bypass NOSUPERUSER NOBYPASSRLS;');
    await admin.query('REVOKE studio_bypass FROM CURRENT_USER');
    await admin.query('DROP ROLE IF EXISTS studio_bypass');
  });
});

describe('assertDbRole', () => {
  it('warns rather than refusing to boot when the connection cannot isolate', async () => {
    const db = track(createAdminPool(url));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => void warnings.push(String(m));
    try {
      await assertDbRole(db);
    } finally {
      console.warn = original;
    }
    expect(warnings.join('\n')).toContain('studio_app');
  });

  it('is silent when the connection is safe', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => void warnings.push(String(m));
    try {
      await assertDbRole(db);
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([]);
  });
});

describe('assumeAppRole', () => {
  it('warns and falls back to a role-less pool when the login cannot assume studio_app', async () => {
    const admin = track(createAdminPool(url));
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_probe_norole') THEN
        CREATE ROLE studio_probe_norole LOGIN PASSWORD 'probe-pw' NOSUPERUSER;
      END IF;
    END $$`);
    try {
      // Deliberately never GRANT studio_app TO studio_probe_norole: this is the managed-PostgreSQL
      // login whose administrator never ran migration 007's GRANT (no CREATEROLE).
      const probeUrl = url.replace(/\/\/[^@]+@/, '//studio_probe_norole:probe-pw@');

      const probeAdmin1 = createAdminPool(probeUrl);
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (m: unknown) => void warnings.push(String(m));
      let fallback: Db;
      try {
        fallback = await assumeAppRole(probeUrl, probeAdmin1);
      } finally {
        console.warn = original;
        await probeAdmin1.end();
      }
      expect(warnings.join('\n')).toContain('GRANT studio_app TO');
      // The fallback pool actually works: it just cannot enforce row-level security.
      expect(await fallback.query<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      await fallback.end();
    } finally {
      await admin.query('DROP ROLE IF EXISTS studio_probe_norole');
    }
  });
});
