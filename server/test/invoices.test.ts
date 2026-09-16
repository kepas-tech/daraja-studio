import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { parseInvoices } from '../src/invoices/parse.js';

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
}
const INV = { customerName: 'Jane Doe', customerPhone: '0700123456', invoiceName: 'September rent', accountReference: 'HSE-12', billedPeriod: 'September 2026', dueDate: '2099-09-30', amountCents: 150000 };

describe('parseInvoices', () => {
  it('reads the seven columns with a header and names bad lines', () => {
    const { rows, errors } = parseInvoices('name,phone,invoice,account,period,due,amount\nJane,0700123456,Rent,HSE-1,Sep 2026,2026-09-30,1500\nJohn,bad,Rent,HSE-2,Sep,2026-09-30,10\nJoe,0700123457,Rent,HSE-3,Sep,30/09/2026,10');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ customerPhone: '254700123456', amountCents: 150000, dueDate: '2026-09-30' });
    expect(errors).toEqual([{ line: 3, message: 'Not a Kenyan mobile number.' }, { line: 4, message: 'The due date must be YYYY-MM-DD.' }]);
  });
});

describe('invoices', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { await resetTables(deps.db); ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); fake.reset(); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  // Opting in answers 202 and finishes in the background; wait for settings() to settle.
  const optInWith = async (body: object) => {
    const r = await h(request(app).post('/api/invoices/opt-in')).send(body);
    if (r.status !== 202) return r;
    for (let i = 0; i < 100; i++) {
      const st = await request(app).get('/api/invoices/settings').set('Cookie', cookie);
      if (!st.body.registering) return { status: 200, body: st.body } as typeof r;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('opt-in never settled');
  };
  const optIn = () => optInWith({ email: 'bills@kepas.example', officialContact: '0700000000', sendReminders: true, password: 'correct horse' });

  it('opting in stores the app key encrypted and never echoes it; sending needs it first', async () => {
    expect((await h(request(app).post('/api/invoices')).send(INV)).status).toBe(409);
    const r = await optIn();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ optedIn: true, email: 'bills@kepas.example', phone: '254700000000', reminders: true });
    expect(JSON.stringify(r.body)).not.toContain('fake-app-key');
    const [row] = await deps.db.query<{ value: string; encrypted: boolean }>(`SELECT value, encrypted FROM settings WHERE key='env.sandbox.billManagerAppKey'`);
    expect(row.encrypted).toBe(true);
    expect(row.value).not.toContain('fake-app-key');
    expect(fake.calls.find((c) => c.path.endsWith('/optin'))!.body.callbackurl).toBe('https://studio.example/cb/sekret/billmanager');
    // Opting in again updates the details and keeps the key.
    const again = await optInWith({ email: 'other@kepas.example', officialContact: '0700000001', sendReminders: false, password: 'correct horse' });
    expect(again.body).toMatchObject({ optedIn: true, email: 'other@kepas.example', reminders: false });
    expect(fake.calls.some((c) => c.path.endsWith('/change-optin-details'))).toBe(true);
  });

  it('a refusal from Safaricom lands on settings() as lastError, with nothing stored, and the next try clears it', async () => {
    fake.rejectsSync('400', 'Organisation not allowed on Bill Manager');
    const r = await optIn();
    expect(r.body.optedIn).toBe(false);
    expect(r.body.registering).toBe(false);
    expect(typeof r.body.lastError).toBe('string');
    expect(await deps.settings.get('env.sandbox.billManagerAppKey')).toBeNull();
    fake.reset();
    const ok = await optIn();
    expect(ok.body).toMatchObject({ optedIn: true, lastError: null });
  });

  it('sends an invoice with a minted reference, refuses when items do not add up, and stores nothing on a refusal', async () => {
    await optIn();
    const bad = await h(request(app).post('/api/invoices')).send({ ...INV, items: [{ name: 'Rent', amountCents: 100000 }] });
    expect(bad.status).toBe(400);
    const r = await h(request(app).post('/api/invoices')).send({ ...INV, items: [{ name: 'Rent', amountCents: 140000 }, { name: 'Water', amountCents: 10000 }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ reference: 'INV-000001', status: 'sent', amountCents: 150000, paidCents: 0 });
    const sent = fake.calls.find((c) => c.path.endsWith('/single-invoicing'))!;
    expect(sent.body).toMatchObject({ externalReference: 'INV-000001', billedPhoneNumber: '254700123456', amount: 1500 });
    expect((sent.body.invoiceItems as unknown[]).length).toBe(2);
    fake.rejectsSync('400', 'Invalid phone');
    // The fake only refuses money/status calls on rejectsSync; a Bill Manager refusal is a non-200 rescode, so simulate via a broken key instead.
    await deps.settings.set('env.sandbox.billManagerAppKey', '');
    expect((await h(request(app).post('/api/invoices')).send(INV)).status).toBe(409);
    expect((await deps.db.query('SELECT 1 FROM customer_invoices')).length).toBe(1);
  });

  it('a payment push matches the open invoice by account, a repeat is a duplicate, partial then full', async () => {
    await optIn();
    const r = await h(request(app).post('/api/invoices')).send(INV);
    const id = r.body.id as string;
    const t1 = await fake.customerPaysInvoice({ account: 'HSE-12', amount: 500 });
    let v = (await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie)).body;
    expect(v).toMatchObject({ status: 'partly_paid', paidCents: 50000 });
    expect(v.payments.length).toBe(1);
    await fake.customerPaysInvoice({ account: 'HSE-12', amount: 500, transactionId: t1 });
    v = (await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie)).body;
    expect(v.paidCents).toBe(50000);
    await fake.customerPaysInvoice({ account: 'HSE-12', amount: 1000 });
    v = (await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie)).body;
    expect(v).toMatchObject({ status: 'paid', paidCents: 150000 });
    expect(v.paidAt).toBeTruthy();
    // The payments are in History too.
    const hist = await request(app).get('/api/requests?type=invoice_payment').set('Cookie', cookie);
    expect(hist.body.items.length).toBe(2);
    // The push was answered with Bill Manager's own ack.
    const cb = await request(app).post('/cb/sekret/billmanager').set('X-Forwarded-For', SAF_IP).send({ transactionId: 'BMX', paidAmount: 1, msisdn: '254700123456', dateCreated: 'x', accountReference: 'NOPE', shortCode: '600999' });
    expect(cb.body).toEqual({ rescode: '200', resmsg: 'Success' });
    const un = await request(app).get('/api/invoices/unmatched').set('Cookie', cookie);
    expect(un.body.items.map((x: { receipt: string }) => x.receipt)).toEqual(['BMX']);
  });

  it('cancel works only on an unpaid invoice; recording a payment tells Safaricom and marks it', async () => {
    await optIn();
    const a = (await h(request(app).post('/api/invoices')).send(INV)).body;
    const b = (await h(request(app).post('/api/invoices')).send({ ...INV, accountReference: 'HSE-13' })).body;
    const pay = await h(request(app).post(`/api/invoices/${a.id}/payment`)).send({ paymentDate: '2026-09-16', amountCents: 150000, reference: 'CASH-1', payer: 'Jane' });
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe('paid');
    expect(fake.calls.find((c) => c.path.endsWith('/reconciliation'))!.body).toMatchObject({ externalReference: 'INV-000001', paidAmount: 1500, transactionId: 'CASH-1' });
    expect((await h(request(app).post(`/api/invoices/${a.id}/cancel`)).send({})).status).toBe(409);
    const c = await h(request(app).post(`/api/invoices/${b.id}/cancel`)).send({});
    expect(c.body.status).toBe('cancelled');
    expect(fake.calls.some((x) => x.path.endsWith('/cancel-single-invoice'))).toBe(true);
    const dup = await h(request(app).post(`/api/invoices/${a.id}/payment`)).send({ paymentDate: '2026-09-16', amountCents: 1, reference: 'CASH-1', payer: 'Jane' });
    expect(dup.status).toBe(409);
  });

  it('bulk: one bad row sends nothing; a clean list is one call and N rows; overdue is derived', async () => {
    await optIn();
    const bad = await h(request(app).post('/api/invoices/bulk')).send({ text: 'Jane,0700123456,Rent,HSE-1,Sep,2026-09-30,1500\nJohn,bad,Rent,HSE-2,Sep,2026-09-30,10' });
    expect(bad.status).toBe(400);
    expect((await deps.db.query('SELECT 1 FROM customer_invoices')).length).toBe(0);
    const ok = await h(request(app).post('/api/invoices/bulk')).send({ text: 'Jane,0700123456,Rent,HSE-1,Sep,2020-09-30,1500\nJohn,0700123457,Rent,HSE-2,Sep,2099-09-30,10' });
    expect(ok.status).toBe(201);
    expect(ok.body.count).toBe(2);
    const bulkCall = fake.calls.filter((c) => c.path.endsWith('/bulk-invoicing'));
    expect(bulkCall.length).toBe(1);
    const list = (await request(app).get('/api/invoices?filter=overdue').set('Cookie', cookie)).body.items;
    expect(list.map((i: { reference: string; status: string }) => [i.reference, i.status])).toEqual([['INV-000001', 'overdue']]);
    expect((await request(app).get('/api/invoices?filter=open').set('Cookie', cookie)).body.items.length).toBe(2);
    expect((await request(app).get('/api/invoices?filter=open&q=john').set('Cookie', cookie)).body.items.length).toBe(1);
    const many = await h(request(app).post('/api/invoices/cancel')).send({ ids: list.map((i: { id: string }) => i.id) });
    expect(many.body.cancelled).toBe(1);
  });
});
