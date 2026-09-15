import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { eatStamp, pulledToPayment } from '../src/money_in/service.js';

const SAF_IP = '196.201.214.200';
// eslint-disable-next-line prefer-const -- forward-referenced by the fake's post closure, assigned once makeApp returns
let app: express.Express;
const fake = createFakeSafaricom({ post: async (path, body) => { await request(app).post(path).set('X-Forwarded-For', SAF_IP).send(body as object); } });
const made = makeApp({ fetchImpl: fake.fetchImpl });
app = made.app;
const { deps, close } = made;
afterAll(close);

async function ready() {
  await deps.settings.set('env.sandbox.shortcode', '600999');
  await deps.settings.set('daraja.environment', 'sandbox');
  await deps.settings.set('env.sandbox.consumerKey', 'k');
  await deps.settings.set('env.sandbox.consumerSecret', 's');
  await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.settings.set('org.nominatedNumber', '254700000000');
}

describe('money in', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { await resetTables(deps.db); ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); fake.reset(); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const register = () => h(request(app).post('/api/money-in/register')).send({ password: 'correct horse' });

  it('registers both addresses, idempotently, and reports them', async () => {
    const a = await register();
    expect(a.status).toBe(200);
    expect(a.body.c2bRegisteredAt).toBeTruthy();
    expect(a.body.pullRegisteredAt).toBeTruthy();
    expect((await register()).status).toBe(200);
    const regs = fake.calls.filter((c) => c.path.endsWith('/registerurl'));
    expect(regs.length).toBe(2);
    expect(regs[0].body.ConfirmationURL).toBe('https://studio.example/cb/sekret/c2b/confirm');
    expect(regs[0].body.ValidationURL).toBe('https://studio.example/cb/sekret/c2b/validate');
    expect(fake.calls.find((c) => c.path.endsWith('/pulltransactions/v1/register'))!.body.NominatedNumber).toBe('254700000000');
    const st = await request(app).get('/api/money-in/status').set('Cookie', cookie);
    expect(st.body.mode).toBe('sandbox');
    expect(st.body.c2bRegisteredAt).toBeTruthy();
  });

  it('refuses to register before the public address is tested, and without the owner password', async () => {
    await deps.settings.delete('public.verifiedAt');
    expect((await register()).status).toBe(409);
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    expect((await h(request(app).post('/api/money-in/register')).send({})).status).toBe(403);
  });

  it('a customer paying lands in History as a completed c2b row, seen by the recent list', async () => {
    await register();
    await fake.customerPays({ amount: 250, phone: '254700123456', account: 'ACC-9' });
    const list = await request(app).get('/api/requests?type=c2b').set('Cookie', cookie);
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0]).toMatchObject({ type: 'c2b', status: 'completed', amountCents: 25000, receipt: expect.stringMatching(/^RC/) });
    const recent = await request(app).get('/api/money-in/recent').set('Cookie', cookie);
    expect(recent.body.items.length).toBe(1);
    // History's default list shows it too.
    const all = await request(app).get('/api/requests').set('Cookie', cookie);
    expect(all.body.items.map((r: { type: string }) => r.type)).toEqual(['c2b']);
  });

  it('the check finds a payment whose confirmation never arrived, once', async () => {
    await register();
    await fake.customerPays({ amount: 100, phone: '254700123456', account: 'ACC-1', deliver: false });
    await fake.customerPays({ amount: 300, phone: '254700123457', account: 'ACC-2' });
    const r = await h(request(app).post('/api/money-in/check')).send({});
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(1);
    expect((await h(request(app).post('/api/money-in/check')).send({})).body.found).toBe(0);
    expect((await deps.db.query('SELECT 1 FROM requests WHERE type=$1', ['c2b'])).length).toBe(2);
    const found = (await deps.db.query<{ result_source: string; amount_cents: string }>(`SELECT result_source, amount_cents FROM requests WHERE account_reference='ACC-1'`))[0];
    expect(found).toEqual({ result_source: 'poll', amount_cents: '10000' });
    expect((await request(app).get('/api/money-in/status').set('Cookie', cookie)).body.pullCheckedAt).toBeTruthy();
  });

  it('the check refuses until registered, and the hourly job is then a no-op', async () => {
    expect((await h(request(app).post('/api/money-in/check')).send({})).status).toBe(409);
    await fake.customerPays({ amount: 100, phone: '254700123456', account: 'ACC-1', deliver: false });
    await deps.moneyIn.checkMissedIfRegistered();
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
  });

  it('formats the pull window in East Africa Time and reads a pulled record', () => {
    expect(eatStamp(new Date('2026-09-16T07:15:30Z'))).toBe('2026-09-16 10:15:30');
    expect(pulledToPayment({ transactionId: 'RC1', trxDate: '2026-09-16 10:15:30', msisdn: '254700123456', sender: 'JANE', billreference: 'A', amount: '12.5' })).toMatchObject({ transId: 'RC1', amount: 12.5, transTime: '20260916101530', billRefNumber: 'A' });
    expect(pulledToPayment({ amount: '1' })).toBeNull();
  });
});
