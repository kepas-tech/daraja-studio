import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminPool, withSystem, type Db } from '../src/db/pool.js';
import { deleteOrg } from './helpers.js';
import { migrate } from '../src/db/migrate.js';
import { MODULES } from '../src/modules/registry.js';
import { buildApp, loadExtension, EXTENSION_API_VERSION, EXTENSION_ROUTE_PREFIX, type AppDeps } from '../src/app.js';
import { makeApp, loginAsOwner } from './helpers.js';

/**
 * The seam for a package installed beside Studio: one place to add declarations, one router under a
 * namespace of its own, a quiet try at boot, and a second migrations directory.
 *
 * What is tested here is the seam itself: what a package is handed, where its router can and cannot
 * be mounted, that the router carries the studio's own gate rather than the package's promises, and
 * that nothing about the product changes without a package. Nothing here knows what the private
 * package does with any of it.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const coreMigrations = path.join(here, '..', 'migrations');
const fixtureDir = path.join(here, 'extension');
const fixtureMigrations = path.join(fixtureDir, 'migrations');
const fixtureEntry = path.join(fixtureDir, 'index.js');
const broken = (file: string) => path.join(fixtureDir, 'broken', file);

/** The core's own declarations, as they stand in the registry the app is built from. */
const coreKeys = ['contacts', 'businesses', 'statements', 'invoices', 'people', 'approvals', 'reports', 'reconcile', 'cases', 'reversals', 'standing_orders', 'express_checkout', 'bonga', 'notifications', 'developer', 'feed', 'sweep', 'scheduled_payments', 'custody'];

/** What the boot hands the loader. In the running studio these are the real ones. */
const host = (deps: AppDeps) => ({ db: deps.db, settings: deps.settings, orgs: deps.orgs });

describe('an installed package', () => {
  it('is not there by default, and Studio boots and answers exactly as it does without one', async () => {
    const { app, deps, close } = makeApp();
    try {
      // Nothing is installed under that name, and that is not an error: one try, then silence.
      expect(await loadExtension(host(deps), '@kepas/studio-nothing-installed')).toEqual({ loaded: false, routers: [] });
      expect(MODULES.map((m) => m.key)).toEqual(coreKeys);

      const { cookie, csrf } = await loginAsOwner(app, deps);
      const view = await request(app).get('/api/modules').set('Cookie', cookie).set('x-csrf-token', csrf);
      expect(view.status).toBe(200);
      expect(view.body.modules.map((m: { key: string }) => m.key)).toEqual(coreKeys);
      // And every part still reads as it did: nothing off but the two declared and not built, and
      // no menu entry hidden by a package that is not installed.
      const me = (await request(app).get('/api/auth/me').set('Cookie', cookie)).body;
      expect(me.modules.off).toEqual(['scheduled_payments', 'custody']);
      expect(me.modules.menuOff).toEqual([]);
      // The namespace a package would take is empty until one does, so it cannot collide with the
      // product: nothing the studio mounts answers under it, with a session or without one.
      expect((await request(app).get('/api/x/anything')).status).toBe(404);
      expect((await request(app).get('/api/x/anything').set('Cookie', cookie)).status).toBe(404);
      expect(EXTENSION_ROUTE_PREFIX).toBe('/api/x');
    } finally { await deps.events.stop(); await close(); }
  });

  it('stops the boot when a package is installed but cannot start, naming it and the error', async () => {
    const { deps, close } = makeApp();
    try {
      // Installed, so it is not missing, and it throws: that is a boot failure, not silence. Half a
      // package would take its parts away from a studio that has tenants on it, and nobody would
      // notice until something was missing.
      await expect(loadExtension(host(deps), broken('throws-on-load.js')))
        .rejects.toThrow(/throws-on-load\.js is installed but could not be loaded: the fixture package could not start/);
      await expect(loadExtension(host(deps), broken('throws-in-register.js')))
        .rejects.toThrow(/throws-in-register\.js is installed but could not be loaded: the fixture package refused to register/);
    } finally { await deps.events.stop(); await close(); }
  });

  it('refuses a second router, and an address of the package own choosing', async () => {
    const { deps, close } = makeApp();
    try {
      // One router is the promise. A second is a package asking for more than the api gives.
      await expect(loadExtension(host(deps), broken('two-routers.js')))
        .rejects.toThrow(/could not be loaded: a package mounts one router, and this one already mounted \/api\/x\/first/);
      // A package picks a name, never a path: a name that is not one plain segment is refused, so
      // nothing it writes can take its router outside the reserved namespace.
      await expect(loadExtension(host(deps), broken('router-outside.js')))
        .rejects.toThrow(/could not be loaded: a router name is lower-case letters, digits and hyphens/);
    } finally { await deps.events.stop(); await close(); }
  });

  it('registers its own declaration when it is loaded, and the app serves it like any other part', async () => {
    const { deps, close } = makeApp();
    try {
      const load = await loadExtension(host(deps), fixtureEntry);
      expect(load.loaded).toBe(true);
      expect(MODULES.map((m) => m.key)).toEqual([...coreKeys, 'fixture_notes']);

      const app = buildApp({ ...deps, extensionRouters: load.routers });
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

describe('a package router', () => {
  it('is mounted under the reserved namespace, and carries the studio own gate rather than the package promises', async () => {
    const { deps, close } = makeApp();
    try {
      const load = await loadExtension(host(deps), fixtureEntry);
      expect(load.routers.map((r) => r.path)).toEqual(['/api/x/fixture']);
      const app = buildApp({ ...deps, extensionRouters: load.routers });

      // Nobody without a session reaches it: the studio puts the session in front, not the package.
      expect((await request(app).get('/api/x/fixture/notes')).status).toBe(401);
      // And the studio's own address space is untouched either way.
      expect((await request(app).get('/api/settings')).status).toBe(401);

      // After the login, which is what resets the tables a test starts from.
      const { cookie, csrf } = await loginAsOwner(app, deps);
      await deps.settings.set('public.url', 'https://studio.test');
      // The api's version, the organisation the request is in, the database handle and the settings
      // reader all arrived, and the organisation context is the caller's.
      const notes = await request(app).get('/api/x/fixture/notes').set('Cookie', cookie);
      expect(notes.status).toBe(200);
      expect(notes.body).toMatchObject({ apiVersion: EXTENSION_API_VERSION, org: 'org-1', setting: 'https://studio.test' });
      expect(typeof notes.body.modules).toBe('number');

      // A write without the CSRF token is refused, and it is the studio's own check doing it.
      const noToken = await request(app).post('/api/x/fixture/org').set('Cookie', cookie).send({ name: 'From a package' });
      expect(noToken.status).toBe(403);
      expect(noToken.body.error.code).toBe('csrf');
      // With it, the package makes an organisation through the studio's own service.
      const made = await request(app).post('/api/x/fixture/org').set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'From a package' });
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ status: 'pending', secretReturned: true });
      const [row] = await withSystem(() => deps.db.query<{ name: string; is_host: boolean }>(
        `SELECT name, is_host FROM orgs WHERE id = $1`, [made.body.id]));
      expect(row).toMatchObject({ name: 'From a package', is_host: false });
      // A package's organisation is a real one, so the test takes it away again rather than leaving
      // an extra organisation in the database every other test shares.
      await deleteOrg(made.body.id);
    } finally { await deps.events.stop(); await close(); }
  });
});

describe('a package that stands a tenant up', () => {
  it('is given one call that makes the organisation and its first owner, and a plain refusal when the username is gone', async () => {
    const { deps, close } = makeApp();
    try {
      const load = await loadExtension(host(deps), fixtureEntry);
      const app = buildApp({ ...deps, extensionRouters: load.routers });
      const { cookie, csrf } = await loginAsOwner(app, deps);
      const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
      const body = { name: 'Kodisap Limited', username: 'kodisap', displayName: 'Jane Wanjiru', password: 'a-good-password-1' };
      const orgCount = async () => Number((await withSystem(() => deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM orgs')))[0]!.n);

      // The package hands over a plain password and gets back the pair: it never hashes one and
      // never writes the people table itself.
      const made = await h(request(app).post('/api/x/fixture/provision')).send(body);
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ org: { status: 'pending' }, person: { username: 'kodisap', isOwner: true } });
      const [org] = await withSystem(() => deps.db.query<{ name: string }>('SELECT name FROM orgs WHERE id = $1', [made.body.org.id]));
      expect(org!.name).toBe('Kodisap Limited');

      // A username somebody on the install already has is a plain refusal, and nothing new exists.
      const before = await orgCount();
      const again = await h(request(app).post('/api/x/fixture/provision')).send({ ...body, name: 'Another Tenant' });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({ code: 'username_taken' });
      expect(again.body.error.message).toMatch(/already uses that name/);
      expect(await orgCount()).toBe(before);
      const theirs = await withSystem(() => deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM orgs WHERE name = $1', ['Another Tenant']));
      expect(theirs[0]!.n).toBe('0');

      // And the person the package made can sign in at the studio.
      const login = await request(app).post('/api/auth/login').send({ username: 'kodisap', password: 'a-good-password-1' });
      expect(login.status).toBe(200);
      await deleteOrg(made.body.org.id);
    } finally { await deps.events.stop(); await close(); }
  });
});

describe("a package's own migrations", () => {
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

