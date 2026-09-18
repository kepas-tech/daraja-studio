import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { recordC2b } from '../src/money_in/record.js';

/**
 * Round 3, phase D-1: check nothing is missing.
 *
 * Safaricom's own record is pulled for a window and compared with Studio's rows, and the balances
 * Safaricom reported are compared with the money that moved between them. The check reads: nothing
 * it lists is recorded, corrected or applied.
 */
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
  await deps.settings.set('env.sandbox.pullRegisteredAt', new Date().toISOString());
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.settings.set('org.nominatedNumber', '254700000000');
}

describe('check nothing is missing', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { await resetTables(deps.db); ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); fake.reset(); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const check = (days = 7) => h(request(app).post('/api/reconcile')).send({ days });

  it('lists a payment Safaricom shows and Studio has no row for, and writes nothing', async () => {
    await fake.customerPays({ amount: 250, phone: '254700123456', account: 'ACC-9', receipt: 'RC00000001', deliver: false });
    const r = await check();
    expect(r.status).toBe(200);
    expect(r.body.missing).toHaveLength(1);
    expect(r.body.missing[0]).toMatchObject({ receipt: 'RC00000001', amountCents: 25000, accountReference: 'ACC-9', phone: '254700123456' });
    expect(r.body.safaricom).toMatchObject({ records: 1, totalCents: 25000 });
    expect(r.body.studio).toMatchObject({ records: 0, totalCents: 0 });
    expect(r.body.extra).toEqual([]);
    // Read only: the check records nothing, and no request row was written by it.
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
    expect((await deps.db.query('SELECT 1 FROM callbacks_raw')).length).toBe(0);
  });

  it('leaves a payment both sides agree on alone, and lists one only Studio has', async () => {
    // Both sides have this one: Safaricom lists it in the pull, and Studio has its row.
    await fake.customerPays({ amount: 100, phone: '254700123456', account: 'ACC-1', receipt: 'RC00000002', deliver: false });
    await recordC2b(deps, {
      transactionType: 'Pay Bill', transId: 'RC00000002', transTime: '20260916101530', amount: 100, shortCode: '600999', billRefNumber: 'ACC-1',
      invoiceNumber: '', thirdPartyTransId: '', msisdn: '254700123456', firstName: 'Jane', middleName: '', lastName: 'Doe',
    }, 'callback');
    await recordC2b(deps, {
      transactionType: 'Pay Bill', transId: 'RC00000009', transTime: '20260916101530', amount: 500, shortCode: '600999', billRefNumber: 'ACC-2',
      invoiceNumber: '', thirdPartyTransId: '', msisdn: '254700123457', firstName: 'John', middleName: '', lastName: 'Doe',
    }, 'callback');
    const r = await check(30);
    expect(r.body.missing).toEqual([]);
    expect(r.body.extra).toHaveLength(1);
    expect(r.body.extra[0]).toMatchObject({ receipt: 'RC00000009', amountCents: 50000, accountReference: 'ACC-2', type: 'c2b' });
    expect(r.body.studio).toMatchObject({ records: 2, totalCents: 60000 });
  });

  it('compares the two balances Safaricom reported with the money that moved between them', async () => {
    const before = new Date(Date.now() - 3 * 3_600_000);
    const after = new Date(Date.now() - 1 * 3_600_000);
    await deps.db.query(
      `INSERT INTO balances(working_cents, utility_cents, charges_paid_cents, raw, queried_at) VALUES (1000000, 500000, NULL, '{}'::jsonb, $1), (1250000, 480000, 5000, '{}'::jsonb, $2)`,
      [before, after]);
    // Between them: 2,500 in and 1,000 out, with a 50 charge — so Utility should read 500,000 − 1,000 − 50.
    await deps.db.query(
      `INSERT INTO requests(type, originator_conversation_id, status, amount_cents, currency, created_at, charge_cents) VALUES
        ('c2b','oc-r1','completed',250000,'KES',$1,0),
        ('b2c','oc-r2','sent',100000,'KES',$1,5000)`, [new Date(Date.now() - 2 * 3_600_000)]);
    const r = await check(7);
    expect(r.body.balance.latest).toMatchObject({ workingCents: 1250000, utilityCents: 480000 });
    expect(r.body.balance.previous).toMatchObject({ workingCents: 1000000, utilityCents: 500000 });
    expect(r.body.balance.movement).toMatchObject({
      inCents: 250000, outCents: 100000, chargeCents: 5000, paymentsIn: 1, paymentsOut: 1,
      expectedWorkingCents: 1250000, expectedUtilityCents: 395000,
      // Working agrees exactly; Utility is short of what Studio expected, and says by how much.
      workingDifferenceCents: 0, utilityDifferenceCents: 85000,
    });
  });

  it('refuses before Money in is turned on, and needs the money-in permission', async () => {
    await deps.settings.delete('env.sandbox.pullRegisteredAt');
    const off = await check();
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('not_registered');
    await ready();
    const anonymous = await request(app).post('/api/reconcile').send({ days: 7 });
    expect(anonymous.status).toBe(401);
  });
});
