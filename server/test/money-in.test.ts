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
  // Registration answers 202 and finishes in the background; wait for status() to settle.
  const register = async () => {
    const r = await h(request(app).post('/api/money-in/register')).send({ password: 'correct horse' });
    if (r.status !== 202) return r;
    for (let i = 0; i < 50; i++) {
      const st = await request(app).get('/api/money-in/status').set('Cookie', cookie);
      if (!st.body.registering) return { status: 200, body: st.body } as typeof r;
      await new Promise((res) => setTimeout(res, 40));
    }
    throw new Error('registration never settled');
  };

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

  it('"URLs are already registered" counts as registered, with the caveat flagged', async () => {
    fake.rejectsSync('500.003.1001', 'URLs are already registered');
    const r = await register();
    expect(r.body.c2bRegisteredAt).toBeTruthy();
    expect(r.body.pullRegisteredAt).toBeTruthy();
    expect(r.body.alreadyRegistered).toBe(true);
    expect(r.body.lastError).toBeNull();
    // A clean registration later clears the caveat.
    expect((await register()).body.alreadyRegistered).toBe(false);
  });

  it('a refusal by Safaricom is kept as the last error, in three lines, and clears on a later success', async () => {
    fake.rejectsSync('400.003.01', 'Bad Request - Invalid ShortCode');
    const r = await register();
    expect(r.status).toBe(200);
    expect(r.body.c2bRegisteredAt).toBeNull();
    expect(r.body.registering).toBe(false);
    expect(r.body.lastError).toContain('Invalid ShortCode');
    const ok = await register();
    expect(ok.body.c2bRegisteredAt).toBeTruthy();
    expect(ok.body.lastError).toBeNull();
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

  it('the recent list shows every kind of money in, not only paybill payments (phase A)', async () => {
    await register();
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, sent_at, result_at) VALUES ('invoice_payment','invpay:1','completed',100,'KES','phone','254700123456',now(),now())`);
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, sent_at) VALUES ('express','oc-ex','sent',200,'KES','shortcode','174379',now())`);
    const recent = await request(app).get('/api/money-in/recent').set('Cookie', cookie);
    expect(recent.body.items.map((r: { type: string }) => r.type).sort()).toEqual(['express', 'invoice_payment']);
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
    // Phase A: the portal's `sender` column and the three callback-shaped name fields are two
    // spellings of the same thing. The named parts win when Safaricom sent them; `sender` stands in
    // when it did not, whole (it carries the phone too, which the row's own value already has).
    expect(pulledToPayment({ transactionId: 'RC2', amount: '1', sender: 'JANE DOE' })).toMatchObject({ firstName: 'JANE DOE', middleName: '', lastName: '' });
    expect(pulledToPayment({ transactionId: 'RC3', amount: '1', FirstName: 'Jane', MiddleName: 'Wanjiru', LastName: 'Doe' })).toMatchObject({ firstName: 'Jane', middleName: 'Wanjiru', lastName: 'Doe' });
    expect(pulledToPayment({ transactionId: 'RC4', amount: '1', sender: 'MPESA', FirstName: 'Jane', MiddleName: 'Wanjiru', LastName: 'Doe' })).toMatchObject({ firstName: 'Jane', middleName: 'Wanjiru', lastName: 'Doe' });
  });
});
