import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner } from './helpers.js';
import type { C2bPayment } from '@kepas/daraja-js';
import { recordC2b } from '../src/money_in/record.js';
import { createWebhookWriter } from '../src/webhooks/writer.js';

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

  it('a user who pays the paybill directly with their account number is named to the app that owns the business', async () => {
    const made = (await h(request(app).post('/api/keys')).send({ name: 'sinro app', role: 'collector', businessId: sinro, webhookUrl: 'https://sinro.example/api/payments/webhook' })).body;
    const account = (await request(app).put('/api/accounts/by-ref/user-77').set(as(made.secret)).send({ name: 'Jane' })).body;
    const out = await recordC2b({ db: deps.db, events: deps.events }, {
      transactionType: 'Pay Bill', transId: 'UIO0000077', transTime: '20260924201742', amount: 50, shortCode: '600999', billRefNumber: account.fullNumber,
      invoiceNumber: '', orgAccountBalance: '', thirdPartyTransId: '', msisdn: '254700123456', firstName: 'JANE', middleName: '', lastName: 'DOE',
    } as unknown as C2bPayment, 'callback', { silent: true });
    const sent: { event: string; payload: Record<string, unknown>; keyId: string | null }[] = [];
    const writer = createWebhookWriter({
      db: deps.db, events: deps.events,
      webhooks: { enqueue: async (event: string, payload: Record<string, unknown>, _id: string, keyId: string | null) => { sent.push({ event, payload, keyId }); return { id: 'd1' }; } } as never,
    });
    await writer.handle({ type: 'request.updated', orgId: deps.db.getFallbackOrg(), payload: { id: out.requestId } } as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('payment.received');
    expect(sent[0]!.keyId).toBe(made.key.id);
    expect(sent[0]!.payload).toMatchObject({ amountCents: 5000, receipt: 'UIO0000077', account: { externalRef: 'user-77', number: account.fullNumber }, business: { id: sinro } });
  });
});
