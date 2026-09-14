import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeApp, loginAsOwner } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import { requireMoneyReady } from '../src/money_out/ready.js';
import { requireAuth, requireCsrf } from '../src/auth/middleware.js';
import { orgContext } from '../src/http/orgContext.js';
import { errorMiddleware } from '../src/util/errors.js';

const { app, deps, close } = makeApp();
afterAll(close);

// The guard is exercised through a throwaway route rather than the real /api/send/phone. That
// route cannot be appended to the app `makeApp()` returns: `buildApp` already mounts
// `app.use('/api', notFound)` ahead of where a test-added route would land, so any request
// under /api would 404 there before ever reaching a route added afterward. Instead the probe
// is mounted on its own small app that shares the same `deps` (db/settings/config) —
// requireAuth/requireCsrf only look at the DB-backed session, not which Express instance is
// serving the request, so logging in via the real app and probing this one is equivalent.
const probeApp = express();
probeApp.use(express.json());
// requireAuth no longer looks up the session itself  — orgContext does that and puts the
// request inside its organisation, so this standalone app needs it too, the way buildApp's does.
probeApp.use(orgContext(deps));
probeApp.post('/api/_ready_probe', requireAuth(deps.db), requireCsrf, requireMoneyReady(deps), (_req, res) => res.status(204).end());
probeApp.use(errorMiddleware);

describe('requireMoneyReady', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });

  it('409 public_url_unverified until the public address is tested', async () => {
    const r = await request(probeApp).post('/api/_ready_probe').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('public_url_unverified');
    expect(r.body.error.message).toBe('Test your public address in Settings first.');
  });

  it('409 no_operator until a verified operator exists', async () => {
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    let r = await request(probeApp).post('/api/_ready_probe').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_operator');
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS',$1,'pending')`, [encrypt(deps.config.secretKey, 'c')]);
    r = await request(probeApp).post('/api/_ready_probe').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.body.error.code).toBe('no_operator');
    await deps.db.query(`UPDATE operators SET status='verified'`);
    r = await request(probeApp).post('/api/_ready_probe').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(204);
  });
});
