import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';

const push = vi.fn(async () => ({ merchantRequestId: 'MR_1', checkoutRequestId: 'ws_CO_1', responseCode: '0', responseDescription: 'Success', customerMessage: 'ok' }));
const { app, deps, close } = makeApp({
  daraja: {
    get: async () => ({ collect: { stkPush: push } }) as never,
    getForOperator: async () => { throw new Error('an STK push must never need an initiator operator'); },
    invalidate: () => {},
    stkEnabled: async () => true,
  },
});
afterAll(async () => { await deps.events.stop(); await close(); });

const BODY = { phone: '0700123456', amountCents: 100, accountReference: 'INV-7' };

describe('POST /api/collect/stk', () => {
  let auth: { cookie: string; csrf: string };
  beforeEach(async () => {
    auth = await loginAsOwner(app, deps);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    push.mockClear();
  });
  const ask = (body: unknown) => request(app).post('/api/collect/stk').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body);

  it('creates the request and answers with it', async () => {
    const r = await ask(BODY);
    expect(r.status).toBe(201);
    expect(r.body.type).toBe('stk');
    expect(r.body.status).toBe('sent');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('asks for no password: a counter raises these all day and a send\'s step-up does not apply', async () => {
    // The confirmation copy promises a password before money leaves or before who may move it
    // changes. Taking money does neither, so no `password` field is sent and none is required.
    const r = await ask(BODY);
    expect(r.status).toBe(201);
  });

  it('refuses without the permission', async () => {
    await resetTables(deps.db);
    await deps.db.query(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('clerk','Clerk',$1,false)`, [await hashPassword('correct horse')]);
    const login = await request(app).post('/api/auth/login').send({ username: 'clerk', password: 'correct horse' });
    const r = await request(app).post('/api/collect/stk')
      .set('Cookie', login.headers['set-cookie'][0] as string).set('X-CSRF-Token', login.body.csrf as string).send(BODY);
    expect(r.status).toBe(403);
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses without CSRF', async () => {
    const r = await request(app).post('/api/collect/stk').set('Cookie', auth.cookie).send(BODY);
    expect(r.status).toBe(403);
    expect(push).not.toHaveBeenCalled();
  });

  it('refuses until the public address is tested, because the answer would never arrive', async () => {
    await deps.db.query(`DELETE FROM settings WHERE key='public.verifiedAt'`);
    const r = await ask(BODY);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('public_url_unverified');
    expect(push).not.toHaveBeenCalled();
  });

  it('rejects a missing reference and a bad amount in plain English', async () => {
    expect((await ask({ ...BODY, accountReference: '' })).status).toBe(400);
    expect((await ask({ ...BODY, amountCents: 0 })).status).toBe(400);
    expect(push).not.toHaveBeenCalled();
  });
});
