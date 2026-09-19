import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdminPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { MODULES } from '../src/modules/registry.js';
import { loadExtension } from '../src/app.js';
import { makeApp, loginAsOwner } from './helpers.js';

/**
 * The seam for a package installed beside Studio: one place to add declarations, one quiet try at
 * boot, and a second migrations directory. What is tested here is the seam itself — that it works
 * with a package installed, and that nothing about the product changes without one.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const coreMigrations = path.join(here, '..', 'migrations');
const fixtureDir = path.join(here, 'extension');
const fixtureMigrations = path.join(fixtureDir, 'migrations');
const fixtureEntry = path.join(fixtureDir, 'index.js');

/** The core's own declarations, as they stand in the registry the app is built from. */
const coreKeys = ['contacts', 'businesses', 'statements', 'invoices', 'people', 'approvals', 'reports', 'reconcile', 'cases', 'reversals', 'standing_orders', 'express_checkout', 'bonga', 'notifications', 'developer', 'feed', 'sweep', 'scheduled_payments', 'custody'];

describe('an installed package', () => {
  it('is not there by default, and Studio boots and answers exactly as it does without one', async () => {
    // Nothing is installed under that name, and that is not an error: one try, then silence.
    expect(await loadExtension('@kepas/studio-nothing-installed')).toBe(false);
    expect(MODULES.map((m) => m.key)).toEqual(coreKeys);

    const { app, deps, close } = makeApp();
    try {
      const { cookie, csrf } = await loginAsOwner(app, deps);
      const view = await request(app).get('/api/modules').set('Cookie', cookie).set('x-csrf-token', csrf);
      expect(view.status).toBe(200);
      expect(view.body.modules.map((m: { key: string }) => m.key)).toEqual(coreKeys);
      // And every part still reads as it did: nothing off but the two declared and not built, and
      // no menu entry hidden by a package that is not installed.
      const me = (await request(app).get('/api/auth/me').set('Cookie', cookie)).body;
      expect(me.modules.off).toEqual(['scheduled_payments', 'custody']);
      expect(me.modules.menuOff).toEqual([]);
    } finally { await deps.events.stop(); await close(); }
  });

  it('stops the boot when a package is installed but cannot start, naming it and the error', async () => {
    // Installed, so it is not missing, and it throws: that is a boot failure, not silence. Half a
    // package would take its parts away from a studio without anybody noticing.
    await expect(loadExtension(path.join(fixtureDir, 'broken', 'throws-on-load.js')))
      .rejects.toThrow(/throws-on-load\.js is installed but could not be loaded: the fixture package could not start/);
  });

  it('stops the boot when a package refuses while registering', async () => {
    await expect(loadExtension(path.join(fixtureDir, 'broken', 'throws-in-register.js')))
      .rejects.toThrow(/throws-in-register\.js is installed but could not be loaded: the fixture package refused to register/);
  });

  it('registers its own declaration when it is loaded, and the app serves it like any other part', async () => {
    expect(await loadExtension(fixtureEntry)).toBe(true);
    expect(MODULES.map((m) => m.key)).toEqual([...coreKeys, 'fixture_notes']);

    const { app, deps, close } = makeApp();
    try {
      const { cookie, csrf } = await loginAsOwner(app, deps);
      const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
      const view = await h(request(app).get('/api/modules'));
      const mine = view.body.modules.find((m: { key: string }) => m.key === 'fixture_notes');
      expect(mine).toMatchObject({
        name: 'Fixture notes', built: true, switchable: true, on: false, changed: false,
        sentence: 'A part of Studio that an installed package declares, used only to prove the seam.',
      });
      // It is in no tier, so it starts off and the owner switches it on like anything else.
      expect(view.body.tiers.every((t: { on: string[] }) => !t.on.includes('fixture_notes'))).toBe(true);
      const on = await h(request(app).post('/api/modules/fixture_notes')).send({ enabled: true, password: 'correct horse' });
      expect(on.status).toBe(200);
      expect(on.body.modules.find((m: { key: string }) => m.key === 'fixture_notes').on).toBe(true);
      const audit = await deps.db.query<{ action: string; target: string }>(
        `SELECT action, target FROM audit_log WHERE action='modules.changed' AND target='fixture_notes'`);
      expect(audit).toHaveLength(1);
    } finally { await deps.events.stop(); await close(); }
  });
});

describe('a package\'s own migrations', () => {
  let db: Db;
  beforeAll(() => { db = createAdminPool(process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test'); });
  afterAll(async () => { await db.end(); });

  it('are read from the second directory and numbered from 900', async () => {
    const applied = await migrate(db, coreMigrations, fixtureMigrations);
    expect(applied).toContain('900');
    const [table] = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='extension_fixture_notes'`);
    expect(table!.n).toBe('1');
    const [row] = await db.query<{ version: string; name: string }>(`SELECT version, name FROM schema_migrations WHERE version='900'`);
    expect(row!.name).toBe('900_extension_fixture.sql');
    // Running again changes nothing: the version is recorded like any other migration.
    expect(await migrate(db, coreMigrations, fixtureMigrations)).toEqual([]);
  });

  it('are refused below 900, where they would collide with the core', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-migrations-'));
    try {
      await fs.writeFile(path.join(dir, '850_too_low.sql'), 'SELECT 1;');
      await expect(migrate(db, coreMigrations, dir)).rejects.toThrow(/900/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('are not read at all when nothing is configured', async () => {
    expect(await migrate(db, coreMigrations)).toEqual([]);
  });
});
