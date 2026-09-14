import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync, publicEncrypt, constants } from 'node:crypto';
import { withSystem } from '../src/db/pool.js';
import { makeApp, TEST_ORG_ID } from './helpers.js';
import { resetTables } from './helpers.js';

const PASSKEY = 'a'.repeat(64);
const OWN_PHONE = '254792471415';

// A well-formed 256-byte (RSA-2048) SecurityCredential, as if pasted from the Safaricom portal's
// own "Generate Security Credential" tool — see operators.test.ts for the same construction. Used
// here only so the operator step in these tests needs no certificate of its own.
const OPERATOR_CREDENTIAL = publicEncrypt(
  { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey, padding: constants.RSA_PKCS1_PADDING },
  Buffer.from('op-secret'),
).toString('base64');

// The commit gate refuses a Safaricom endpoint literal outside oauthCheck.ts (server/test/qr.test.ts
// carries the same note) — matched by suffix rather than the full path for that reason.
const { app, deps, close } = makeApp({
  fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/oauth/') && u.includes('v1/generate')) return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
    if (u.includes('/cb/')) { await request(app).post(new URL(u).pathname).send(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }); }
    // The passkey step's own test push. Never a real prompt — this is the fake transport, and no
    // async callback delivery is needed for the proof: markPasskeyProven fires on the ack itself.
    if (u.includes('/stkpush/') && !u.includes('query')) {
      return new Response(JSON.stringify({ MerchantRequestID: 'MR1', CheckoutRequestID: 'ws_CO_setup1', ResponseCode: '0', ResponseDescription: 'Accepted' }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch,
});
afterAll(close);

describe('setup environment', () => {
  it('lets the wizard pick production before any shortcode exists, without a confirmation', async () => {
    await resetTables(deps.db);
    await request(app).get('/api/setup/status');
    const owner = await request(app).post('/api/setup/owner').send({ displayName: 'Nelson', username: 'nelson', password: 'correct horse battery' });
    expect(owner.status).toBe(201);
    const h = (r: request.Test) => r.set('Cookie', owner.headers['set-cookie'][0]).set('x-csrf-token', owner.body.csrf);
    const r = await h(request(app).post('/api/setup/environment')).send({ environment: 'production' });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('production');
    // Back to this step with a production shortcode already stored: still no confirmation while
    // setup is unfinished, whether the answer is the same or changed.
    await h(request(app).post('/api/setup/uses')).send({ payOut: true, collect: false });
    await h(request(app).post('/api/setup/org')).send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' });
    await h(request(app).post('/api/setup/shortcode')).send({ shortcode: '4052037' });
    expect((await h(request(app).post('/api/setup/environment')).send({ environment: 'production' })).status).toBe(200);
    expect((await h(request(app).post('/api/setup/environment')).send({ environment: 'sandbox' })).status).toBe(200);
    expect((await h(request(app).post('/api/setup/environment')).send({ environment: 'production' })).status).toBe(200);
    // The owner's name can be corrected from the wizard; the username stays.
    expect((await h(request(app).put('/api/auth/display-name')).send({ displayName: 'Nelson Lemein' })).status).toBe(204);
    expect((await h(request(app).put('/api/auth/display-name')).send({ displayName: '' })).status).toBe(400);
    const me = await h(request(app).get('/api/auth/me'));
    expect(me.body.person.display_name).toBe('Nelson Lemein');
  });
});

describe('setup wizard', () => {
  beforeAll(async () => { await resetTables(deps.db); });

  it('walks the whole wizard, and closes the wizard routes once setup is complete', async () => {
    let st = await request(app).get('/api/setup/status');
    expect(st.body).toEqual({ needsOwner: true, completed: false, step: null, uses: null, passkeyProven: false });

    const owner = await request(app).post('/api/setup/owner').send({ displayName: 'Owner', username: 'owner', password: 'correct horse battery' });
    expect(owner.status).toBe(201);
    const cookie = owner.headers['set-cookie'][0]; const csrf = owner.body.csrf;
    const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);

    expect((await request(app).post('/api/setup/owner').send({ displayName: 'X', username: 'x', password: 'correct horse battery' })).status).toBe(409);

    st = await request(app).get('/api/setup/status');
    expect(st.body.step).toBe('environment');
    expect(st.body.uses).toBeNull();

    // Both ticked, so every step below is on this walk's path — the untested one (collect-only
    // skips the operator; pay-out-only skips the passkey) is covered on its own further down.
    expect((await h(request(app).post('/api/setup/uses')).send({ payOut: true, collect: true, stk: true })).status).toBe(204);
    st = await request(app).get('/api/setup/status');
    expect(st.body.uses).toEqual({ payOut: true, collect: true, stk: true });

    const envResp = await h(request(app).post('/api/setup/environment')).send({ environment: 'sandbox' });
    expect(envResp.status).toBe(200);
    expect(envResp.body).toEqual({ mode: 'sandbox', ready: { creds: false, operator: false } });
    expect((await h(request(app).post('/api/setup/org')).send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' })).status).toBe(204);
    const scResp = await h(request(app).post('/api/setup/shortcode')).send({ shortcode: '600999' });
    expect(scResp.status).toBe(200);
    expect(scResp.body).toEqual({ verifiedName: null, verifyError: null });
    const d = await h(request(app).post('/api/setup/daraja')).send({ consumerKey: 'k', consumerSecret: 's' });
    expect(d.body.ok).toBe(true);

    st = await request(app).get('/api/setup/status');
    expect(st.body.step).toBe('public-url');

    expect((await h(request(app).post('/api/setup/public-url')).send({ url: 'https://studio.example' })).status).toBe(204);
    const t = await h(request(app).post('/api/setup/public-url/test'));
    expect(t.body.ok).toBe(true);

    // Only reachable now: the test push needs a real callback address to answer, which is why the
    // passkey step comes after the public address, not before it.
    st = await request(app).get('/api/setup/status');
    expect(st.body.step).toBe('passkey');

    const pk = await h(request(app).post('/api/setup/passkey')).send({ passkey: PASSKEY, phone: OWN_PHONE });
    expect(pk.status).toBe(200);
    expect(pk.body.proven).toBe(true);
    st = await request(app).get('/api/setup/status');
    expect(st.body.passkeyProven).toBe(true);
    expect(st.body.step).toBe('operator');

    expect((await h(request(app).post('/api/setup/complete'))).status).toBe(409);
    await h(request(app).post('/api/setup/operator')).send({ name: 'KEPAS', credential: OPERATOR_CREDENTIAL });
    // The operator's own probe is asynchronous — it waits for a real balance callback, which is
    // operators.test.ts's job to exercise. Here only /complete's own gating is under test, so the
    // outcome that probe would eventually reach is written directly.
    await withSystem(() => deps.db.query(`UPDATE operators SET status='verified' WHERE org_id=$1`, [TEST_ORG_ID]));

    expect((await h(request(app).post('/api/setup/complete'))).status).toBe(204);
    st = await request(app).get('/api/setup/status');
    expect(st.body).toMatchObject({ needsOwner: false, completed: true, step: 'done' });

    // The wizard steps must not stay open forever — once setup is complete, they 409
    // rather than silently letting a still-valid owner session change Daraja creds etc. without
    // ever being asked for the studio password again (these routes carry no step-up check).
    const afterComplete = await h(request(app).post('/api/setup/daraja')).send({ consumerKey: 'k2', consumerSecret: 's2' });
    expect(afterComplete.status).toBe(409);
    expect(afterComplete.body.error.code).toBe('setup_done');
    // GET /status stays public and unaffected.
    st = await request(app).get('/api/setup/status');
    expect(st.body.completed).toBe(true);
  });

  it('refuses an install that would do nothing at all', async () => {
    await resetTables(deps.db);
    const owner = await request(app).post('/api/setup/owner').send({ displayName: 'Owner', username: 'owner', password: 'correct horse battery' });
    const cookie = owner.headers['set-cookie'][0]; const csrf = owner.body.csrf;
    const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
    const r = await h(request(app).post('/api/setup/uses')).send({ payOut: false, collect: false });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('nothing_chosen');
  });

  it('receiving over paybill or till alone needs no passkey: the wizard skips straight to done', async () => {
    await resetTables(deps.db);
    const owner = await request(app).post('/api/setup/owner').send({ displayName: 'Owner', username: 'owner', password: 'correct horse battery' });
    const h = (r: request.Test) => r.set('Cookie', owner.headers['set-cookie'][0]).set('x-csrf-token', owner.body.csrf);
    await h(request(app).post('/api/setup/uses')).send({ payOut: false, collect: true });
    expect((await request(app).get('/api/setup/status')).body.uses).toEqual({ payOut: false, collect: true, stk: false });
    await h(request(app).post('/api/setup/environment')).send({ environment: 'sandbox' });
    await h(request(app).post('/api/setup/org')).send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' });
    await h(request(app).post('/api/setup/shortcode')).send({ shortcode: '600999' });
    await h(request(app).post('/api/setup/daraja')).send({ consumerKey: 'k', consumerSecret: 's' });
    await h(request(app).post('/api/setup/public-url')).send({ url: 'https://studio.example' });
    await h(request(app).post('/api/setup/public-url/test'));
    expect((await request(app).get('/api/setup/status')).body.step).toBe('done');
  });

  it('a business that only takes money in never sees the operator step, and cannot finish without a proven passkey', async () => {
    await resetTables(deps.db);
    const owner = await request(app).post('/api/setup/owner').send({ displayName: 'Owner', username: 'owner', password: 'correct horse battery' });
    const cookie = owner.headers['set-cookie'][0]; const csrf = owner.body.csrf;
    const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
    await h(request(app).post('/api/setup/uses')).send({ payOut: false, collect: true, stk: true });
    await h(request(app).post('/api/setup/environment')).send({ environment: 'sandbox' });
    await h(request(app).post('/api/setup/org')).send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' });
    await h(request(app).post('/api/setup/shortcode')).send({ shortcode: '600999' });
    await h(request(app).post('/api/setup/daraja')).send({ consumerKey: 'k', consumerSecret: 's' });
    await h(request(app).post('/api/setup/public-url')).send({ url: 'https://studio.example' });
    await h(request(app).post('/api/setup/public-url/test'));

    let st = await request(app).get('/api/setup/status');
    expect(st.body.step).toBe('passkey');

    expect((await h(request(app).post('/api/setup/complete'))).status).toBe(409);

    await h(request(app).post('/api/setup/passkey')).send({ passkey: PASSKEY, phone: OWN_PHONE });

    st = await request(app).get('/api/setup/status');
    // Never asked for an operator: a business that only takes money in has no use for one.
    expect(st.body.step).toBe('done');

    expect((await h(request(app).post('/api/setup/complete'))).status).toBe(204);
  });

  it('a business that only pays out never sees the passkey step', async () => {
    await resetTables(deps.db);
    const owner = await request(app).post('/api/setup/owner').send({ displayName: 'Owner', username: 'owner', password: 'correct horse battery' });
    const cookie = owner.headers['set-cookie'][0]; const csrf = owner.body.csrf;
    const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
    await h(request(app).post('/api/setup/uses')).send({ payOut: true, collect: false });
    await h(request(app).post('/api/setup/environment')).send({ environment: 'sandbox' });
    await h(request(app).post('/api/setup/org')).send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' });
    await h(request(app).post('/api/setup/shortcode')).send({ shortcode: '600999' });
    await h(request(app).post('/api/setup/daraja')).send({ consumerKey: 'k', consumerSecret: 's' });

    const st = await request(app).get('/api/setup/status');
    // Never asked for a passkey: a business that never collects has no use for one.
    expect(st.body.step).toBe('public-url');
  });

  it('a wrong passkey is refused, proves nothing, and does not advance the step — the wrong-passkey case', async () => {
    await resetTables(deps.db);
    const failing = makeApp({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/oauth/') && u.includes('v1/generate')) return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
        if (u.includes('/cb/')) { await request(failing.app).post(new URL(u).pathname).send(JSON.parse(String(init?.body))); return new Response('{}', { status: 200 }); }
        // Safaricom refuses a wrong passkey at the acknowledgement, before any phone rings.
        if (u.includes('/stkpush/') && !u.includes('query')) {
          return new Response(JSON.stringify({ MerchantRequestID: '', CheckoutRequestID: '', ResponseCode: '1', ResponseDescription: 'Wrong credentials' }), { status: 200 });
        }
        return new Response('{}', { status: 500 });
      }) as typeof fetch,
    });
    try {
      const owner = await request(failing.app).post('/api/setup/owner').send({ displayName: 'Owner', username: 'owner', password: 'correct horse battery' });
      const cookie = owner.headers['set-cookie'][0]; const csrf = owner.body.csrf;
      const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
      await h(request(failing.app).post('/api/setup/uses')).send({ payOut: false, collect: true, stk: true });
      await h(request(failing.app).post('/api/setup/environment')).send({ environment: 'sandbox' });
      await h(request(failing.app).post('/api/setup/org')).send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' });
      await h(request(failing.app).post('/api/setup/shortcode')).send({ shortcode: '600999' });
      await h(request(failing.app).post('/api/setup/daraja')).send({ consumerKey: 'k', consumerSecret: 's' });
      await h(request(failing.app).post('/api/setup/public-url')).send({ url: 'https://studio.example' });
      await h(request(failing.app).post('/api/setup/public-url/test'));

      const pk = await h(request(failing.app).post('/api/setup/passkey')).send({ passkey: 'wrong', phone: OWN_PHONE });
      expect(pk.status).toBe(200);
      expect(pk.body.proven).toBe(false);

      const st = await request(failing.app).get('/api/setup/status');
      expect(st.body.step).toBe('passkey');
      expect(st.body.passkeyProven).toBe(false);
    } finally {
      await failing.close();
    }
  });

  // /complete must itself promote a boot-created organisation still
  // sitting `pending` — the shape every install's own organisation #1 is in until this route runs,
  // since nothing else ever moves it (sign-up's callback verifies a tenant instead, and never
  // touches this one).
  it('promotes a pending organisation to verified once setup completes', async () => {
    await resetTables(deps.db);
    const owner = await request(app).post('/api/setup/owner').send({ displayName: 'Owner', username: 'owner', password: 'correct horse battery' });
    expect(owner.status).toBe(201);
    const cookie = owner.headers['set-cookie'][0]; const csrf = owner.body.csrf;
    const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
    await h(request(app).post('/api/setup/uses')).send({ payOut: true, collect: false });
    await h(request(app).post('/api/setup/environment')).send({ environment: 'sandbox' });
    await h(request(app).post('/api/setup/org')).send({ name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' });
    await h(request(app).post('/api/setup/shortcode')).send({ shortcode: '600999' });
    await h(request(app).post('/api/setup/daraja')).send({ consumerKey: 'k', consumerSecret: 's' });
    await h(request(app).post('/api/setup/public-url')).send({ url: 'https://studio.example' });
    await h(request(app).post('/api/setup/public-url/test'));
    await h(request(app).post('/api/setup/operator')).send({ name: 'KEPAS', credential: OPERATOR_CREDENTIAL });
    await withSystem(() => deps.db.query(`UPDATE operators SET status='verified' WHERE org_id=$1`, [TEST_ORG_ID]));

    // Exactly the shape a freshly booted install's organisation #1 is in before this route ever
    // runs — `pending`, `verified_at` unset.
    await withSystem(() => deps.db.query(`UPDATE orgs SET status='pending', verified_at=NULL WHERE id=$1`, [TEST_ORG_ID]));

    const complete = await h(request(app).post('/api/setup/complete'));
    expect(complete.status).toBe(204);

    const [org] = await withSystem(() =>
      deps.db.query<{ status: string; verified_at: Date | null }>('SELECT status, verified_at FROM orgs WHERE id=$1', [TEST_ORG_ID]));
    expect(org.status).toBe('verified');
    expect(org.verified_at).not.toBeNull();
  });

  it('two concurrent owner-creation attempts produce exactly one owner', async () => {
    await resetTables(deps.db);
    const [r1, r2] = await Promise.all([
      request(app).post('/api/setup/owner').send({ displayName: 'A', username: 'racer-a', password: 'correct horse battery' }),
      request(app).post('/api/setup/owner').send({ displayName: 'B', username: 'racer-b', password: 'correct horse battery' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    const rows = await deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM people');
    expect(rows[0].n).toBe('1');
  });
});
