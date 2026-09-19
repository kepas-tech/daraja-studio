import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, makePerson, loginAs, TEST_ORG_ID } from './helpers.js';
import { DEFAULT_SIGNUP_URL, SIGNUP_URL_KEY } from '../src/setup/paybill.js';

/**
 * Step two of the tiers-and-modules design: the one question setup asks on the production path,
 * "Do you have your own paybill or till?", and the screen the second answer leads to.
 */
const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });

describe('the production paybill question', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const status = async () => (await request(app).get('/api/setup/status')).body;

  it('is asked only after production is chosen, and sandbox never sees it', async () => {
    // Sandbox first: straight on to the rest of setup, and the question is not reachable.
    expect((await h(request(app).post('/api/setup/environment')).send({ environment: 'sandbox' })).status).toBe(200);
    expect((await status()).step).toBe('uses');
    const sandbox = await h(request(app).post('/api/setup/paybill')).send({ own: true });
    expect(sandbox.status).toBe(409);
    expect(sandbox.body.error.code).toBe('not_production');

    // Production: the question is the next step.
    expect((await h(request(app).post('/api/setup/environment')).send({ environment: 'production' })).status).toBe(200);
    const st = await status();
    expect(st.step).toBe('paybill');
    expect(st.paybill).toBeNull();
    expect(st.signupUrl).toBe(DEFAULT_SIGNUP_URL);
  });

  it('carries "yes, I have my own" on into today’s setup untouched', async () => {
    await h(request(app).post('/api/setup/environment')).send({ environment: 'production' });
    expect((await h(request(app).post('/api/setup/paybill')).send({ own: true })).status).toBe(204);
    const st = await status();
    expect(st).toMatchObject({ step: 'uses', paybill: 'own' });
    // The answer is recorded like every other setup answer.
    const [row] = await deps.db.query<{ value: string }>(`SELECT value FROM settings WHERE org_id=$1 AND key='setup.paybill'`, [TEST_ORG_ID]);
    expect(row!.value).toBe('own');
  });

  it('leaves the second answer on a screen that says what the alternative is, and never traps anybody', async () => {
    await h(request(app).post('/api/setup/environment')).send({ environment: 'production' });
    expect((await h(request(app).post('/api/setup/paybill')).send({ own: false })).status).toBe(204);
    const st = await status();
    // Still on the question's own step, with the answer recorded: a reload shows the explanation.
    expect(st).toMatchObject({ step: 'paybill', paybill: 'none' });

    // And the way out is the same route: saying yes later carries on where setup left off.
    expect((await h(request(app).post('/api/setup/paybill')).send({ own: true })).status).toBe(204);
    expect((await status()).step).toBe('uses');
  });

  it('serves the sign-up address from one setting, whose blank value hides it and changes nothing else', async () => {
    await h(request(app).post('/api/setup/environment')).send({ environment: 'production' });
    expect((await status()).signupUrl).toBe(DEFAULT_SIGNUP_URL);

    await deps.settings.set(SIGNUP_URL_KEY, 'https://example.test/join');
    expect((await status()).signupUrl).toBe('https://example.test/join');

    await deps.settings.set(SIGNUP_URL_KEY, '   ');
    const blank = await status();
    expect(blank.signupUrl).toBeNull();
    // Nothing else about the screen's state changed: the question and the answer are still there.
    expect(blank).toMatchObject({ step: 'paybill', paybill: null });

    await deps.settings.delete(SIGNUP_URL_KEY);
    expect((await status()).signupUrl).toBe(DEFAULT_SIGNUP_URL);
  });

  it('is the owner’s own answer, like the rest of the wizard', async () => {
    await makePerson(deps.db, TEST_ORG_ID, { username: 'staff', password: 'correct horse', role: 'custom' });
    const staff = await loginAs(app, 'staff', 'correct horse');
    const refused = await request(app).post('/api/setup/paybill').set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf).send({ own: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('owner_only');
    expect((await request(app).post('/api/setup/paybill').send({ own: true })).status).toBe(401);
  });
});
