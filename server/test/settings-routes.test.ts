import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, deleteOrg } from './helpers.js';
import { encrypt, sha256 } from '../src/crypto/secrets.js';
import { hashPassword } from '../src/auth/password.js';
import { withOrg, withSystem } from '../src/db/pool.js';
import { APP_TAKEN } from '../src/settings/service.js';

const { app, deps, close } = makeApp({
  fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/oauth/v1/generate')) return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
    if (u.includes('/cb/')) { await request(app).post(new URL(u).pathname).send(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }); }
    return new Response('{}', { status: 500 });
  }) as typeof fetch,
});
afterAll(close);

describe('settings routes', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });

  it('view shows empty state', async () => {
    const r = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('sandbox');
    expect(r.body.environments.sandbox.ready).toEqual({ creds: false, operator: false });
    expect(r.body.environments.production.ready).toEqual({ creds: false, operator: false });
    expect(r.body.environments.sandbox.consumerKey).toEqual({ saved: false, last4: null });
  });

  // Minor 8: view() must fetch each environment's slot once, not once inline and once again
  // inside envReady().
  it('view() fetches each environment slot once (Minor 8)', async () => {
    const built = makeApp();
    try {
      const { cookie: c2 } = await loginAsOwner(built.app, built.deps);
      let calls = 0;
      const orig = built.deps.settings.getMany.bind(built.deps.settings);
      built.deps.settings.getMany = (async (keys: Parameters<typeof orig>[0]) => { calls++; return orig(keys); }) as typeof built.deps.settings.getMany;
      await request(built.app).get('/api/settings').set('Cookie', c2);
      // 1 for the shared keys + 1 per environment (sandbox, production) = 3.
      expect(calls).toBe(3);
    } finally {
      await built.close();
    }
  });

  it('stores daraja creds after oauth check, requires step-up', async () => {
    const no = await request(app).post('/api/settings/environments/sandbox/daraja').set('Cookie', cookie).set('x-csrf-token', csrf).send({ consumerKey: 'k', consumerSecret: 's' });
    expect(no.status).toBe(403);
    const ok = await request(app).post('/api/settings/environments/sandbox/daraja').set('Cookie', cookie).set('x-csrf-token', csrf).send({ consumerKey: 'k', consumerSecret: 's', password: 'correct horse' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(await deps.settings.get('env.sandbox.consumerSecret')).toBe('s');
    expect(await deps.settings.get('env.sandbox.credsVerifiedAt')).toBeTruthy();
    expect(await deps.settings.get('env.production.consumerSecret')).toBeNull();
  });

  it(':env other than sandbox/production 400s', async () => {
    const r = await request(app).post('/api/settings/environments/staging/daraja').set('Cookie', cookie).set('x-csrf-token', csrf).send({ consumerKey: 'k', consumerSecret: 's', password: 'correct horse' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_env');
  });

  it('public url test round-trips through the callback receiver', async () => {
    await request(app).put('/api/settings/public-url').set('Cookie', cookie).set('x-csrf-token', csrf).send({ url: 'https://studio.example', password: 'correct horse' });
    const r = await request(app).post('/api/settings/public-url/test').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(await deps.settings.get('public.verifiedAt')).toBeTruthy();
  });

  // Minor 9
  it('mode save requires step-up: 403 without a password', async () => {
    const r = await request(app).put('/api/settings/mode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ environment: 'sandbox' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('step_up_required');
  });

  // Minor 9
  it('passkey save requires step-up: 403 without a password', async () => {
    const r = await request(app).post('/api/settings/environments/sandbox/passkey').set('Cookie', cookie).set('x-csrf-token', csrf).send({ passkey: 'pk' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('step_up_required');
  });

  // A4
  it('org save requires step-up: 403 without a password, 204 with the correct one', async () => {
    const noOrg = await request(app).put('/api/settings/org').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' });
    expect(noOrg.status).toBe(403);
    expect(noOrg.body.error.code).toBe('step_up_required');
    const okOrg = await request(app).put('/api/settings/org').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000', password: 'correct horse' });
    expect(okOrg.status).toBe(204);
  });

  it('public-url save requires step-up: 403 without a password', async () => {
    const noUrl = await request(app).put('/api/settings/public-url').set('Cookie', cookie).set('x-csrf-token', csrf).send({ url: 'https://studio.example' });
    expect(noUrl.status).toBe(403);
    expect(noUrl.body.error.code).toBe('step_up_required');
  });

  it('shortcode save requires step-up, verifies only once that environment\'s creds are saved and verified', async () => {
    const no = await request(app).put('/api/settings/environments/sandbox/shortcode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ shortcode: '700111' });
    expect(no.status).toBe(403);
    const unverified = await request(app).put('/api/settings/environments/sandbox/shortcode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ shortcode: '700111', password: 'correct horse' });
    expect(unverified.status).toBe(200);
    expect(unverified.body).toEqual({ verifiedName: null, verifyError: null });
    expect(await deps.settings.get('env.sandbox.shortcode')).toBe('700111');
  });

  // Minor 5: a raw SDK/network error must never reach the browser verbatim — every other
  // Safaricom-facing error in this codebase is curated for exactly this reason.
  it('shortcode verification never forwards a raw SDK/network error message to the browser (Minor 5)', async () => {
    const leaky = 'ECONNRESET internal-host-10.0.0.5-detail';
    const envFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('generate')) return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
      throw new Error(leaky);
    }) as typeof fetch;
    const built = makeApp({ fetchImpl: envFetch });
    try {
      const { cookie: c2, csrf: cs2 } = await loginAsOwner(built.app, built.deps);
      const daraja = await request(built.app).post('/api/settings/environments/sandbox/daraja').set('Cookie', c2).set('x-csrf-token', cs2).send({ consumerKey: 'k', consumerSecret: 's', password: 'correct horse' });
      expect(daraja.body.ok).toBe(true);
      const r = await request(built.app).put('/api/settings/environments/sandbox/shortcode').set('Cookie', c2).set('x-csrf-token', cs2).send({ shortcode: '600999', password: 'correct horse' });
      expect(r.status).toBe(200);
      expect(r.body.verifiedName).toBeNull();
      expect(r.body.verifyError).not.toContain(leaky);
      expect(r.body.verifyError).toBe('Could not verify with Safaricom.');
    } finally {
      await built.close();
    }
  });

  // Minor 6: the one-off verification client must reuse the same cached OAuth token as every
  // other Daraja call, not burn a fresh one on every shortcode save.
  it('shortcode verification reuses the cached OAuth token across calls (Minor 6)', async () => {
    let generateCalls = 0;
    const envFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('generate')) { generateCalls++; return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 }); }
      if (u.includes('/sfcverify/v1/query/info')) return new Response(JSON.stringify({ ResponseMessage: 'Success', OrganizationName: 'KEPAS' }), { status: 200 });
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    const built = makeApp({ fetchImpl: envFetch });
    try {
      const { cookie: c2, csrf: cs2 } = await loginAsOwner(built.app, built.deps);
      // The daraja-creds save (oauthCheck) is a plain HTTP call outside the SDK/tokenStore, so it
      // burns its own token request — the count under test is only what the shortcode saves add.
      await request(built.app).post('/api/settings/environments/sandbox/daraja').set('Cookie', c2).set('x-csrf-token', cs2).send({ consumerKey: 'k', consumerSecret: 's', password: 'correct horse' });
      const afterCreds = generateCalls;
      const first = await request(built.app).put('/api/settings/environments/sandbox/shortcode').set('Cookie', c2).set('x-csrf-token', cs2).send({ shortcode: '600999', password: 'correct horse' });
      expect(first.body).toEqual({ verifiedName: 'KEPAS', verifyError: null });
      expect(generateCalls).toBe(afterCreds + 1);
      const second = await request(built.app).put('/api/settings/environments/sandbox/shortcode').set('Cookie', c2).set('x-csrf-token', cs2).send({ shortcode: '600999', password: 'correct horse' });
      expect(second.body).toEqual({ verifiedName: 'KEPAS', verifyError: null });
      expect(generateCalls).toBe(afterCreds + 1);
    } finally {
      await built.close();
    }
  });

  it('production mode switch needs the shortcode typed back, and never touches credentials', async () => {
    await request(app).put('/api/settings/environments/production/shortcode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ shortcode: '700111', password: 'correct horse' });
    const bad = await request(app).put('/api/settings/mode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ environment: 'production', confirmShortcode: '123', password: 'correct horse' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('confirm_shortcode');
    const good = await request(app).put('/api/settings/mode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ environment: 'production', confirmShortcode: '700111', password: 'correct horse' });
    expect(good.status).toBe(200);
    expect(good.body).toEqual({ mode: 'production', ready: { creds: false, operator: false } });
    expect(await deps.settings.get('daraja.environment')).toBe('production');
    expect(await deps.settings.get('env.production.consumerKey')).toBeNull();
  });

  it('rejects a public url with userinfo, and audits the normalised value rather than the raw input', async () => {
    const bad = await request(app).put('/api/settings/public-url').set('Cookie', cookie).set('x-csrf-token', csrf).send({ url: 'https://user:pass@x.example/?t=1', password: 'correct horse' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_url');

    const good = await request(app).put('/api/settings/public-url').set('Cookie', cookie).set('x-csrf-token', csrf).send({ url: 'https://x.example/foo/', password: 'correct horse' });
    expect(good.status).toBe(204);
    expect(await deps.settings.get('public.url')).toBe('https://x.example/foo');
    const row = (await deps.db.query<{ after_json: string }>(
      `SELECT after_json FROM audit_log WHERE action='settings.public_url' ORDER BY at DESC LIMIT 1`))[0];
    expect(row.after_json).toBe('https://x.example/foo');
  });

  // Minor 5
  it('rejects an empty allowlist and an out-of-range octet', async () => {
    const empty = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf).send({ allowlist: [], password: 'correct horse' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('invalid');
    const outOfRange = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf).send({ allowlist: ['999.1.1.1'], password: 'correct horse' });
    expect(outOfRange.status).toBe(400);
    const good = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf).send({ allowlist: ['1.2.3.4'], password: 'correct horse' });
    expect(good.status).toBe(204);
  });

  // Minor 6
  it('install-secret reveal responds with Cache-Control: no-store', async () => {
    const r = await request(app).post('/api/settings/install-secret/reveal').set('Cookie', cookie).set('x-csrf-token', csrf).send({ password: 'correct horse' });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  // Minor 7 (rewritten): each environment holds its own creds now, so a mode switch must never
  // re-check or invalidate the OTHER environment's already-verified pair — that was exactly the
  // bug this task fixes (switching to production used to overwrite sandbox's saved values).
  it('each environment\'s creds stay independently verified across a mode switch', async () => {
    const envFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.startsWith('https://sandbox.safaricom.co.ke')) return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    const built = makeApp({ fetchImpl: envFetch });
    try {
      const { cookie: c2, csrf: cs2 } = await loginAsOwner(built.app, built.deps);
      await built.deps.settings.set('env.production.shortcode', '700111');
      const stored = await request(built.app).post('/api/settings/environments/sandbox/daraja').set('Cookie', c2).set('x-csrf-token', cs2).send({ consumerKey: 'k', consumerSecret: 's', password: 'correct horse' });
      expect(stored.body.ok).toBe(true);
      const view1 = await request(built.app).get('/api/settings').set('Cookie', c2);
      expect(view1.body.environments.sandbox.ready.creds).toBe(true);
      expect(view1.body.environments.production.ready.creds).toBe(false);

      const switched = await request(built.app).put('/api/settings/mode').set('Cookie', c2).set('x-csrf-token', cs2).send({ environment: 'production', confirmShortcode: '700111', password: 'correct horse' });
      expect(switched.status).toBe(200);
      expect(switched.body.ready.creds).toBe(false);

      const view2 = await request(built.app).get('/api/settings').set('Cookie', c2);
      expect(view2.body.environments.sandbox.ready.creds).toBe(true);
      expect(view2.body.environments.production.ready.creds).toBe(false);
    } finally {
      await built.close();
    }
  });

  // Minor 8 + 9
  it('view never leaks secret values in its JSON body, and a non-owner is refused', async () => {
    await request(app).post('/api/settings/environments/sandbox/daraja').set('Cookie', cookie).set('x-csrf-token', csrf).send({ consumerKey: 'the-key', consumerSecret: 'the-secret', password: 'correct horse' });
    await request(app).post('/api/settings/environments/sandbox/passkey').set('Cookie', cookie).set('x-csrf-token', csrf).send({ passkey: 'the-passkey', password: 'correct horse' });
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('OP', $1, 'pending')`, [encrypt(deps.config.secretKey, 'the-operator-credential')]);

    const r = await request(app).get('/api/settings').set('Cookie', cookie);
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain('the-key');
    expect(raw).not.toContain('the-secret');
    expect(raw).not.toContain('the-passkey');
    expect(raw).not.toContain('the-operator-credential');

    await deps.db.query(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('staff', 'Staff', $1, false)`, [await hashPassword('staff password!!')]);
    const staffLogin = await request(app).post('/api/auth/login').send({ username: 'staff', password: 'staff password!!' });
    const staffCookie = staffLogin.headers['set-cookie'][0];
    const denied = await request(app).get('/api/settings').set('Cookie', staffCookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('owner_only');
  });

  // A5
  it('public-url self-test sends an abort signal and follows redirects manually', async () => {
    let capturedInit: RequestInit | undefined;
    const capturingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response('{}', { status: 301 });
    }) as typeof fetch;
    const built = makeApp({ fetchImpl: capturingFetch });
    try {
      const { cookie: c2, csrf: cs2 } = await loginAsOwner(built.app, built.deps);
      await request(built.app).put('/api/settings/public-url').set('Cookie', c2).set('x-csrf-token', cs2).send({ url: 'https://studio.example', password: 'correct horse' });
      const r = await request(built.app).post('/api/settings/public-url/test').set('Cookie', c2).set('x-csrf-token', cs2);
      expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
      expect(capturedInit?.redirect).toBe('manual');
      expect(r.body.ok).toBe(false);
      expect(r.body.detail).toContain('301');
    } finally {
      await built.close();
    }
  });

  // Minor 10
  it('does not sleep after the final failed public-url poll', async () => {
    const built = makeApp({ fetchImpl: (async () => new Response('{}', { status: 200 })) as typeof fetch });
    try {
      const { cookie: c2, csrf: cs2 } = await loginAsOwner(built.app, built.deps);
      await request(built.app).put('/api/settings/public-url').set('Cookie', c2).set('x-csrf-token', cs2).send({ url: 'https://studio.example', password: 'correct horse' });
      const start = Date.now();
      const r = await request(built.app).post('/api/settings/public-url/test').set('Cookie', c2).set('x-csrf-token', cs2);
      const elapsed = Date.now() - start;
      expect(r.body.ok).toBe(false);
      expect(elapsed).toBeLessThan(2900);
    } finally {
      await built.close();
    }
  });

  // --- Per-environment operators  ---

  it('adding an operator under /environments/:env/operators returns the created view, scoped to that env', async () => {
    await request(app).put('/api/settings/environments/sandbox/shortcode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ shortcode: '600999', password: 'correct horse' });
    await request(app).post('/api/settings/environments/sandbox/daraja').set('Cookie', cookie).set('x-csrf-token', csrf).send({ consumerKey: 'k', consumerSecret: 's', password: 'correct horse' });
    await request(app).put('/api/settings/public-url').set('Cookie', cookie).set('x-csrf-token', csrf).send({ url: 'https://studio.example', password: 'correct horse' });
    await request(app).post('/api/settings/public-url/test').set('Cookie', cookie).set('x-csrf-token', csrf);
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const r = await request(app).post('/api/settings/environments/sandbox/operators').set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'KEPAS', operatorPassword: 'Secret#123', certPem, password: 'correct horse' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('KEPAS');
    expect(r.body.environment).toBe('sandbox');

    const list = await request(app).get('/api/settings/environments/sandbox/operators').set('Cookie', cookie);
    expect(list.body.map((o: { name: string }) => o.name)).toEqual(['KEPAS']);
    const prodList = await request(app).get('/api/settings/environments/production/operators').set('Cookie', cookie);
    expect(prodList.body).toEqual([]);
  });

  it(':env=staging 400s for the operators routes too', async () => {
    const get = await request(app).get('/api/settings/environments/staging/operators').set('Cookie', cookie);
    expect(get.status).toBe(400);
    const post = await request(app).post('/api/settings/environments/staging/operators').set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'X', operatorPassword: 'p', password: 'correct horse' });
    expect(post.status).toBe(400);
  });

  // --- B2C API version (per-environment) ---

  it('B2C API version defaults to auto, validates the value, requires step-up, and is reflected in the view', async () => {
    const view0 = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(view0.body.environments.sandbox.b2cApi).toEqual({ setting: 'auto', detected: null, detectedAt: null });

    const bad = await request(app).put('/api/settings/environments/sandbox/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'v2', password: 'correct horse' });
    expect(bad.status).toBe(400);

    const noPassword = await request(app).put('/api/settings/environments/sandbox/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'v1' });
    expect(noPassword.status).toBe(403);

    const ok = await request(app).put('/api/settings/environments/sandbox/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'v1', password: 'correct horse' });
    expect(ok.status).toBe(204);

    const view1 = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(view1.body.environments.sandbox.b2cApi.setting).toBe('v1');

    const row = (await deps.db.query<{ after_json: { environment: string; version: string } }>(`SELECT after_json FROM audit_log WHERE action='settings.b2c_api' ORDER BY at DESC LIMIT 1`))[0];
    expect(row.after_json).toEqual({ environment: 'sandbox', version: 'v1' });
  });

  it('changing the B2C API version clears any detected value', async () => {
    await deps.settings.set('env.sandbox.b2cApiDetected', 'v3');
    await deps.settings.set('env.sandbox.b2cApiDetectedAt', new Date().toISOString());
    const r = await request(app).put('/api/settings/environments/sandbox/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'v1', password: 'correct horse' });
    expect(r.status).toBe(204);
    const view = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(view.body.environments.sandbox.b2cApi).toEqual({ setting: 'v1', detected: null, detectedAt: null });
  });

  it('re-saving the same B2C API version does not clear an existing detected value', async () => {
    await deps.settings.set('env.sandbox.b2cApi', 'auto');
    await deps.settings.set('env.sandbox.b2cApiDetected', 'v1');
    await deps.settings.set('env.sandbox.b2cApiDetectedAt', '2026-09-07T00:00:00.000Z');
    const r = await request(app).put('/api/settings/environments/sandbox/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'auto', password: 'correct horse' });
    expect(r.status).toBe(204);
    const view = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(view.body.environments.sandbox.b2cApi).toEqual({ setting: 'auto', detected: 'v1', detectedAt: '2026-09-07T00:00:00.000Z' });
  });

  it('production and sandbox keep independent B2C API versions', async () => {
    await request(app).put('/api/settings/environments/production/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'v3', password: 'correct horse' });
    const view = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(view.body.environments.production.b2cApi.setting).toBe('v3');
    expect(view.body.environments.sandbox.b2cApi.setting).toBe('auto');
  });

  it('the old un-scoped routes are gone', async () => {
    expect((await request(app).put('/api/settings/environment').set('Cookie', cookie).set('x-csrf-token', csrf).send({ environment: 'sandbox', password: 'correct horse' })).status).toBe(404);
    expect((await request(app).post('/api/settings/daraja').set('Cookie', cookie).set('x-csrf-token', csrf).send({ consumerKey: 'k', consumerSecret: 's', password: 'correct horse' })).status).toBe(404);
    expect((await request(app).post('/api/settings/passkey').set('Cookie', cookie).set('x-csrf-token', csrf).send({ passkey: 'p', password: 'correct horse' })).status).toBe(404);
    expect((await request(app).get('/api/settings/operators').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).post('/api/settings/operators').set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'X', password: 'correct horse' })).status).toBe(404);
  });

  // Minor 10, final review: a rejected retry restores the previous claim, and that restore can
  // itself lose a race to another organisation legitimately claiming the same key in the meantime.
  it('a lost race restoring the previous key on a rejected retry is a 409, and releases the org\'s own claim entirely', async () => {
    const RACER = '00000000-0000-4000-8000-00000000e001';
    let oauthCalls = 0;
    const envFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (!u.includes('generate')) return new Response('{}', { status: 500 });
      oauthCalls += 1;
      if (oauthCalls === 1) return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
      // The exact race this guards against: between this retry giving up its own claim (by
      // provisionally claiming its new, about-to-fail key) and it trying to restore the one it
      // just released, another organisation legitimately claims that same key for itself.
      await withSystem(() => built.deps.db.query(
        `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ($1,'racer','Racer','pending',false,'racer-secret-hash','unset',gen_random_bytes(32))`,
        [RACER],
      ));
      await withOrg(RACER, () => built.deps.db.query(
        `INSERT INTO settings(org_id, key, value, encrypted) VALUES ($1,'env.sandbox.consumerKeyHash',$2,false)`,
        [RACER, sha256('good-key')],
      ));
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    const built = makeApp({ fetchImpl: envFetch });
    try {
      const { cookie: c2, csrf: cs2 } = await loginAsOwner(built.app, built.deps);
      const first = await request(built.app).post('/api/settings/environments/sandbox/daraja').set('Cookie', c2).set('x-csrf-token', cs2)
        .send({ consumerKey: 'good-key', consumerSecret: 's', password: 'correct horse' });
      expect(first.body).toEqual({ ok: true, message: 'Safaricom accepted the key and secret.' });

      const second = await request(built.app).post('/api/settings/environments/sandbox/daraja').set('Cookie', c2).set('x-csrf-token', cs2)
        .send({ consumerKey: 'bad-key', consumerSecret: 's', password: 'correct horse' });
      // Same response shape as claiming a taken key fresh: a 409, not a 200 the caller could read
      // as "try again with the same key" — the key really is gone from this organisation now.
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('app_taken');
      expect(second.body.error.message).toContain(APP_TAKEN);
      // The org must not be left looking like it still claims the rejected, stale key either.
      expect(await built.deps.settings.get('env.sandbox.consumerKeyHash')).toBeNull();
    } finally {
      await deleteOrg(RACER);
      await built.close();
    }
  });
});
