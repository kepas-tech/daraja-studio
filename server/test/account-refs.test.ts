import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner } from './helpers.js';

/**
 * Migration 050: an app opens one account per user, under its key's own business, by its own
 * reference for the user, and asks that user to pay into it. Real PostgreSQL; the STK push is a stub,
 * so nothing reaches Safaricom.
 */
const push = vi.fn(async (_input: { accountReference?: string }) => ({ merchantRequestId: 'MR_1', checkoutRequestId: 'ws_CO_REF', responseCode: '0', responseDescription: 'Success', customerMessage: 'ok' }));
const { app, deps, close } = makeApp({
  daraja: {
    get: async () => ({ collect: { stkPush: push } }) as never,
    getForOperator: async () => { throw new Error('an STK push must never need an initiator operator'); },
    invalidate: () => {},
    stkEnabled: async () => true,
  },
});
afterAll(async () => { await deps.events.stop(); await close(); });

describe('an app\'s own users, as accounts', () => {
  let auth: { cookie: string; csrf: string };
  let sinro = ''; let kepas = '';
  const h = (r: request.Test) => r.set('Cookie', auth.cookie).set('x-csrf-token', auth.csrf);
  const key = async (businessId?: string) => (await h(request(app).post('/api/keys')).send({ name: 'sinro app ' + Math.random(), role: 'collector', ...(businessId ? { businessId } : {}) })).body.secret as string;
  const as = (secret: string) => ({ Authorization: `Bearer ${secret}` });

  beforeEach(async () => {
    auth = await loginAsOwner(app, deps);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    kepas = (await h(request(app).post('/api/businesses')).send({ name: 'KEPAS' })).body.id;
    sinro = (await h(request(app).post('/api/businesses')).send({ name: 'SINRO' })).body.id;
    push.mockClear();
  });

  it('opens an account on first use, finds the same one after, in the key\'s business only', async () => {
    const k = await key(sinro);
    const first = await request(app).put('/api/accounts/by-ref/user-42').set(as(k)).send({ name: 'Jane' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ businessId: sinro, externalRef: 'user-42', name: 'Jane' });
    expect(first.body.fullNumber).toMatch(/^\d{6,12}$/);
    const again = await request(app).put('/api/accounts/by-ref/user-42').set(as(k)).send({});
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    // A key never reaches another business, whatever it names.
    const other = await request(app).put('/api/accounts/by-ref/user-42').set(as(k)).send({ businessId: kepas });
    expect(other.body.businessId ?? sinro).toBe(sinro);
    const found = await request(app).get('/api/accounts/by-ref/user-42').set(as(k));
    expect(found.body.id).toBe(first.body.id);
    expect((await request(app).get('/api/accounts/by-ref/nobody').set(as(k))).status).toBe(404);
  });

  it('ten first calls at once still open one account', async () => {
    const k = await key(sinro);
    const all = await Promise.all(Array.from({ length: 10 }, () => request(app).put('/api/accounts/by-ref/user-7').set(as(k)).send({})));
    expect(new Set(all.map((r) => r.body.id)).size).toBe(1);
    expect(all.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await deps.db.query(`SELECT 1 FROM accounts WHERE external_ref='user-7'`)).length).toBe(1);
  });

  it('a key with no business opens nothing; a person names the business and needs the permission', async () => {
    const k = await key();
    const r = await request(app).put('/api/accounts/by-ref/user-1').set(as(k)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('key_without_business');
    const owner = await h(request(app).put('/api/accounts/by-ref/user-1')).send({ businessId: kepas });
    expect(owner.status).toBe(201);
    expect(owner.body.businessId).toBe(kepas);
  });

  it('asks a user to pay into their own account number, and the payment names them', async () => {
    const k = await key(sinro);
    const r = await request(app).post('/api/collect/stk').set(as(k)).send({ phone: '0700123456', amountCents: 1000, externalRef: 'user-99', callerRef: 'user-99:wallet_topup' });
    expect(r.status).toBe(201);
    const account = (await request(app).get('/api/accounts/by-ref/user-99').set(as(k))).body;
    // Safaricom is asked with the user's own account number as the reference.
    expect(push.mock.calls[0]![0]).toMatchObject({ accountReference: account.fullNumber });
    const [row] = await deps.db.query<{ business_id: string; account_id: string; created_by: string | null }>(`SELECT business_id, account_id, created_by FROM requests WHERE id=$1`, [r.body.id]);
    expect(row).toEqual({ business_id: sinro, account_id: account.id, created_by: null });
    const view = (await request(app).get('/api/requests/' + r.body.id).set(as(k))).body;
    expect(view).toMatchObject({ businessId: sinro, accountId: account.id, accountExternalRef: 'user-99', accountNumber: account.fullNumber });
  });
});
