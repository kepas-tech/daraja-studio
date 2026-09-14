import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { buildApp } from '../src/app.js';
import { makeApp } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(close);

describe('health', () => {
  it('reports ok, the scheduler heartbeat and the send cap', async () => {
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.db).toBe(true);
    // Loopback sees the count; the next test proves nobody else does, which is the property that
    // matters. The exact number is not ours to assert: `orgs` is deliberately absent from the
    // TRUNCATE in resetTables, so organisations survive between files, and several test files share
    // one database. Hard-coding 1 made this pass or fail on which other files happened to be
    // assigned the same database — it broke the moment a new test file shifted that assignment.
    expect(typeof r.body.orgCount).toBe('number');
    expect(r.body.orgCount).toBeGreaterThanOrEqual(1);
    expect(r.body.dbRoleOk).toBe(true);
    expect(typeof r.body.jobsPending).toBe('number');
    expect(r.body.schedulerLastTickAt).toBeNull();
    expect(r.body.sendCapCents).toBeNull();
  });

  // orgCount (how many tenants) and dbRoleOk (whether row-level security is
  // actually enforced) are exactly what an attacker would want before doing anything noisy, so a
  // request that is not from loopback never sees them — only the Docker healthcheck and a local
  // operator do. testDeps() sets STUDIO_TRUST_PROXY=1, so one X-Forwarded-For hop is honoured.
  it('hides orgCount and dbRoleOk from a request that is not from loopback', async () => {
    const r = await request(app).get('/healthz').set('X-Forwarded-For', '8.8.8.8');
    expect(r.status).toBe(200);
    expect(r.body.orgCount).toBeUndefined();
    expect(r.body.dbRoleOk).toBeUndefined();
    // Everything else stays public.
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.jobsPending).toBe('number');
  });

  // The 503 branch's orgCount/dbRoleOk fields need the same coverage.
  it('the 503 branch hides orgCount/dbRoleOk from the public', async () => {
    const brokenDb = { ...deps.db, query: async () => { throw new Error('boom'); } };
    const brokenApp = buildApp({ ...deps, db: brokenDb });

    const pub = await request(brokenApp).get('/healthz').set('X-Forwarded-For', '8.8.8.8');
    expect(pub.status).toBe(503);
    expect(pub.body).toMatchObject({ ok: false, db: false });
    expect(pub.body.orgCount).toBeUndefined();
    expect(pub.body.dbRoleOk).toBeUndefined();

    const loop = await request(brokenApp).get('/healthz');
    expect(loop.status).toBe(503);
    expect(loop.body).toMatchObject({ ok: false, db: false, orgCount: -1, dbRoleOk: false });
  });

  // The active environment's B2C API version, for support/diagnosis without opening Settings.
  it('reports the active environment\'s B2C API setting and detection', async () => {
    // Other files in the suite share this database and may leave a sandbox B2C setting behind.
    for (const k of ['env.sandbox.b2cApi', 'env.sandbox.b2cApiDetected', 'env.sandbox.b2cApiDetectedAt'] as const) await deps.settings.delete(k);
    const r0 = await request(app).get('/healthz');
    expect(r0.body.b2cApi).toEqual({ setting: 'auto', detected: null });
    await deps.settings.set('env.sandbox.b2cApi', 'v1');
    const r1 = await request(app).get('/healthz');
    expect(r1.body.b2cApi).toEqual({ setting: 'v1', detected: null });
    await deps.settings.set('daraja.environment', 'production');
    await deps.settings.set('env.production.b2cApiDetected', 'v3');
    const r2 = await request(app).get('/healthz');
    expect(r2.body.b2cApi).toEqual({ setting: 'auto', detected: 'v3' });
  });

  it('reports the version this server was built from', async () => {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(pkg.version);
  });
});
