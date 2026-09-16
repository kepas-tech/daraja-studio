import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { NO_ANSWER_YET } from '../src/collect/service.js';

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
const ORDER = { name: 'Rent', phone: '0700123456', amountCents: 500000, frequency: '4', startDate: '2026-10-01', endDate: '2027-09-30', accountReference: 'HSE-12', transactionDesc: 'Rent' };
const row = async (id: string) => (await deps.db.query<{ status: string; receipt: string | null; meaning: string | null; result_desc: string | null }>('SELECT status, receipt, meaning, result_desc FROM requests WHERE id=$1', [id]))[0];

describe('standing orders, express checkout and Bonga', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { await resetTables(deps.db); ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); fake.reset(); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);

  it('a standing order is sent, the consent callback completes it, a repeat callback is a duplicate, and the name cannot be reused', async () => {
    fake.duplicatesCallback();
    const r = await h(request(app).post('/api/collect/ratiba')).send(ORDER);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'ratiba', status: 'sent', amountCents: 500000 });
    const sent = fake.calls.find((c) => c.path.endsWith('/createStandingOrderExternal'))!;
    expect(sent.body).toMatchObject({ StandingOrderName: 'Rent', StartDate: '20261001', EndDate: '20270930', Frequency: '4', PartyA: '254700123456', Amount: 5000, TransactionType: 'Standing Order Customer Pay Bill' });
    expect((await deps.db.query(`SELECT 1 FROM jobs WHERE kind='request_timeout' AND done_at IS NULL`)).length).toBe(1);
    await fake.settle();
    expect(await row(r.body.id)).toMatchObject({ status: 'completed' });
    expect((await row(r.body.id)).receipt).toMatch(/^RS\d{8}$/);
    const verdicts = (await deps.db.query<{ verdict: string }>(`SELECT verdict FROM callbacks_raw WHERE path='ratiba' ORDER BY received_at`)).map((x) => x.verdict);
    expect(verdicts).toEqual(['applied', 'duplicate']);
    const again = await h(request(app).post('/api/collect/ratiba')).send(ORDER);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('name_taken');
    // Another name for the same customer is fine.
    expect((await h(request(app).post('/api/collect/ratiba')).send({ ...ORDER, name: 'Water' })).status).toBe(201);
  });

  it('a declined standing order fails with Safaricom\'s words; no answer in time becomes unknown', async () => {
    fake.credentialError();
    const r = await h(request(app).post('/api/collect/ratiba')).send(ORDER);
    await fake.settle();
    expect((await row(r.body.id)).status).toBe('failed');
    fake.neverAnswers();
    const q = await h(request(app).post('/api/collect/ratiba')).send({ ...ORDER, name: 'Quiet' });
    const [job] = await deps.db.query<{ id: string; payload: { requestId: string; meaning: string } }>(`SELECT id, payload FROM jobs WHERE kind='request_timeout' AND payload->>'requestId'=$1`, [q.body.id]);
    expect(job.payload.meaning).toBe(NO_ANSWER_YET);
    await deps.db.query(`UPDATE jobs SET run_at=now() - interval '1 minute' WHERE id=$1`, [job.id]);
    const { createScheduler } = await import('../src/scheduler/loop.js');
    const { buildHandlers } = await import('../src/scheduler/handlers.js');
    const sched = createScheduler(deps.db, buildHandlers({ db: deps.db, events: deps.events, settings: deps.settings, moneyOut: deps.moneyOut, operators: deps.operators, moneyIn: deps.moneyIn, bulk: deps.bulk }), { intervalMs: 60_000 });
    await sched.tick();
    expect(await row(q.body.id)).toMatchObject({ status: 'unknown', meaning: NO_ANSWER_YET });
  });

  it('express checkout prompts the other business\'s till and settles on the flat callback', async () => {
    const r = await h(request(app).post('/api/collect/express')).send({ till: '174379', amountCents: 250000, paymentRef: 'PO-77', partnerName: 'KEPAS' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'express', status: 'sent', recipient: { kind: 'shortcode', value: '174379' } });
    const sent = fake.calls.find((c) => c.path.endsWith('/ussdpush/get-msisdn'))!;
    expect(sent.body).toMatchObject({ primaryShortCode: '174379', receiverShortCode: '600999', amount: 2500, paymentRef: 'PO-77', partnerName: 'KEPAS' });
    await fake.settle();
    const ex = await row(r.body.id);
    expect(ex.status).toBe('completed');
    expect(ex.receipt).toMatch(/^RX\d{8}$/);
    // History shows it; the sweep never polls it.
    const list = await request(app).get('/api/requests?type=express').set('Cookie', cookie);
    expect(list.body.items.length).toBe(1);
  });

  it('Bonga: points are valued, then redeemed; the settlement arrives through Money in and completes the same row', async () => {
    const calc = await h(request(app).post('/api/collect/bonga/calculate')).send({ points: 500 });
    expect(calc.status).toBe(200);
    expect(calc.body).toEqual({ points: 500, amountCents: 10000, rate: 0.2 });
    const off = await h(request(app).post('/api/collect/bonga/redeem')).send({ phone: '0700123456', points: 500, accountReference: 'HSE-12' });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('money_in_off');
    await h(request(app).post('/api/money-in/register')).send({ password: 'correct horse' });
    // Registration finishes in the background; wait for it before redeeming.
    for (let i = 0; i < 50; i++) { if (!(await request(app).get('/api/money-in/status').set('Cookie', cookie)).body.registering) break; await new Promise((res) => setTimeout(res, 40)); }
    const r = await h(request(app).post('/api/collect/bonga/redeem')).send({ phone: '0700123456', points: 500, accountReference: 'HSE-12' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'bonga', status: 'sent', amountCents: 10000 });
    expect(fake.calls.find((c) => c.path.endsWith('/redeem-paybill'))!.body).toMatchObject({ msisdn: '254700123456', amount: 100, bongaPoints: 500, conversionRate: 0.2, accountNumber: 'HSE-12' });
    await fake.settle();
    const settled = await row(r.body.id);
    expect(settled.status).toBe('completed');
    expect(settled.receipt).toMatch(/^RB\d{8}$/);
    // One row, not a bonga row plus a c2b row.
    expect((await deps.db.query(`SELECT type FROM requests WHERE receipt=$1`, [settled.receipt])).length).toBe(1);
  });
});
