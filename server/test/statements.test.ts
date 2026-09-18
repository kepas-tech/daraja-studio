import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { C2bPayment } from '@kepas/daraja-js';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { recordC2b } from '../src/money_in/record.js';
import { periodLabel } from '../src/businesses/statement.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Round 3, phase C: one account's running statement, and who is behind.
 *
 * Everything the statement shows comes from rows that exist — payments in, payouts out, invoices
 * raised — and the only thing the kind of business supplies is what each period expects. Nothing
 * here charges anybody: raising the next invoice and preparing a reminder are both one press by a
 * person, and the tests check that neither moves money on its own.
 */

const sendInvoice = vi.fn(async () => ({ responseCode: '200', responseDescription: 'Invoice sent' }));
const ack = vi.fn(async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_1', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'ok' }));
const daraja: DarajaFactory = {
  get: async () => ({ billManager: { sendInvoice }, b2c: { send: ack } }) as never,
  getForOperator: async () => ({ billManager: { sendInvoice }, b2c: { send: ack }, config: { initiator: 'APIONE' } }) as never,
  invalidate: () => {}, stkEnabled: async () => false,
};
const { app, deps, close } = makeApp({ daraja });
afterAll(close);

let seq = 0;
const payment = (over: Partial<C2bPayment> = {}): C2bPayment => ({
  transactionType: 'Pay Bill', transId: ('R' + String(++seq).padStart(9, '0')).slice(0, 10),
  transTime: '20260916101530', amount: 10000, shortCode: '600999', billRefNumber: '000359',
  invoiceNumber: '', thirdPartyTransId: '', msisdn: '254700123456', firstName: 'Jane', middleName: '', lastName: 'Doe', ...over,
});

describe('statements and arrears', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => {
    await resetTables(deps.db);
    ({ cookie, csrf } = await loginAsOwner(app, deps));
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.settings.set('daraja.environment', 'sandbox');
    await deps.settings.set('env.sandbox.shortcode', '600999');
    await deps.settings.set('env.sandbox.billManagerAppKey', 'fake-app-key');
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
  });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);

  /** A rental business with one tenant at 001359, paying 10,000 a month. */
  async function rental(over: { standing?: number; monthsAgo?: number; kind?: string; name?: string } = {}) {
    const b = (await h(request(app).post('/api/businesses')).send({ name: over.name ?? 'White House', typeKey: over.kind ?? 'rental' })).body;
    const made = (await h(request(app).post(`/api/businesses/${b.id}/accounts`)).send({ name: 'Jane', phone: '254700123456', standingCents: over.standing ?? 1_000_000 })).body;
    if (over.monthsAgo) await deps.db.query(`UPDATE accounts SET created_at = now() - make_interval(months => $2) WHERE id = $1`, [made.id, over.monthsAgo]);
    return { business: b, account: made };
  }

  it('builds the statement from the rows that exist, oldest first, with paid and owed on top', async () => {
    const { business, account } = await rental({ monthsAgo: 3 });
    await recordC2b(deps, payment({ billRefNumber: account.fullNumber, amount: 10000 }), 'callback');
    await h(request(app).post('/api/invoices')).send({ customerName: 'Jane', customerPhone: '0700123456', invoiceName: 'Rent statement', accountReference: account.fullNumber, billedPeriod: 'September 2026', dueDate: '2026-09-30', amountCents: 1_000_000, accountId: account.id });
    const out = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 200000, commandId: 'BusinessPayment', accountId: account.id, password: 'correct horse' });
    expect(out.status).toBe(201);

    const r = await h(request(app).get(`/api/accounts/${account.id}/statement`));
    expect(r.status).toBe(200);
    expect(r.body.account).toMatchObject({ name: 'Jane', fullNumber: account.fullNumber, businessName: 'White House' });
    expect(r.body.type.template.statementNoun).toBe('Rent statement');
    expect(r.body.paidInCents).toBe(1_000_000);
    expect(r.body.paidOutCents).toBe(200000);
    expect(r.body.invoicedCents).toBe(1_000_000);
    // Three months at 10,000 each, one of them paid, and the payout leaves the tenant's account.
    expect(r.body.schedule).toMatchObject({ regular: 'monthly', periodsDue: 3, expectedCents: 3_000_000 });
    expect(r.body.owedCents).toBe(2_000_000);
    expect(r.body.behindPeriods).toBe(2);
    const kinds = r.body.rows.map((x: { kind: string }) => x.kind);
    expect(kinds).toEqual(['in', 'invoice', 'out']);
    expect(r.body.rows[0]).toMatchObject({ kind: 'in', receipt: expect.stringMatching(/^R/), label: 'Pay Bill' });
    expect(r.body.rows[1]).toMatchObject({ kind: 'invoice', label: 'September 2026', reference: 'INV-000001' });
    // Oldest first, and every row is a real one.
    expect(r.body.rows[0].at <= r.body.rows[1].at && r.body.rows[1].at <= r.body.rows[2].at).toBe(true);

    const arrears = await h(request(app).get(`/api/businesses/${business.id}/arrears`));
    expect(arrears.body.hasArrears).toBe(true);
    expect(arrears.body.rows[0]).toMatchObject({ name: 'Jane', owedCents: 2_000_000, behindPeriods: 2, periodsDue: 3, paidInCents: 1_000_000 });
    expect(arrears.body.rows[0].oldestInvoice.reference).toBe('INV-000001');
    expect(arrears.body.behindCount).toBe(1);
  });

  it('never owes less than the invoices already raised, and never counts a period that has not finished', async () => {
    // A tenant who joined today owes nothing: no period has finished and no invoice was raised.
    const fresh = await rental();
    const first = await h(request(app).get(`/api/accounts/${fresh.account.id}/statement`));
    expect(first.body.schedule.periodsDue).toBe(0);
    expect(first.body.owedCents).toBe(0);
    // An invoice raised and unpaid is owed, whatever the schedule says.
    await h(request(app).post('/api/invoices')).send({ customerName: 'Jane', customerPhone: '0700123456', invoiceName: 'Rent statement', accountReference: fresh.account.fullNumber, billedPeriod: 'September 2026', dueDate: '2026-09-30', amountCents: 3_000_000, accountId: fresh.account.id });
    const second = await h(request(app).get(`/api/accounts/${fresh.account.id}/statement`));
    expect(second.body.owedCents).toBe(3_000_000);
    expect(second.body.behindPeriods).toBe(3);
    expect(second.body.unpaidInvoiceCount).toBe(1);
  });

  it('orders the arrears by who is furthest behind, and gives a kind that expects nothing regular no list', async () => {
    const b = (await h(request(app).post('/api/businesses')).send({ name: 'White House', typeKey: 'rental' })).body;
    const rows = [
      { name: 'Amina', standing: 500_000, paid: 0 },
      { name: 'Brian', standing: 1_000_000, paid: 2_000_000 },
      { name: 'Cynthia', standing: 1_000_000, paid: 0 },
    ];
    for (const r of rows) {
      const made = (await h(request(app).post(`/api/businesses/${b.id}/accounts`)).send({ name: r.name, standingCents: r.standing })).body;
      await deps.db.query(`UPDATE accounts SET created_at = now() - interval '3 months' WHERE id = $1`, [made.id]);
      if (r.paid > 0) await recordC2b(deps, payment({ billRefNumber: made.fullNumber, amount: r.paid / 100 }), 'callback');
    }
    const arrears = await h(request(app).get(`/api/businesses/${b.id}/arrears`));
    expect(arrears.body.rows.map((x: { name: string }) => x.name)).toEqual(['Cynthia', 'Amina', 'Brian']);
    // Three months at each standing amount, less what each of them has paid: 30,000 − 0,
    // 15,000 − 0 and 30,000 − 20,000, in cents, most behind first.
    expect(arrears.body.rows.map((x: { owedCents: number }) => x.owedCents)).toEqual([3_000_000, 1_500_000, 1_000_000]);
    expect(arrears.body.behindCount).toBe(3);

    // A shop expects nothing regularly: even with an amount set on the account, the kind carries no
    // schedule, so there is nothing to be behind on and no arrears section at all.
    const shop = await rental({ kind: 'shop', standing: 500_000, name: 'Corner Shop' });
    const shopArrears = await h(request(app).get(`/api/businesses/${shop.business.id}/arrears`));
    expect(shopArrears.body.hasArrears).toBe(false);
    expect(shopArrears.body.rows[0].owedCents).toBe(0);
    const shopStatement = await h(request(app).get(`/api/accounts/${shop.account.id}/statement`));
    expect(shopStatement.body.type.template.accountNoun).toBe('Customer');
    expect(shopStatement.body.schedule.expectedCents).toBeNull();
    expect(shopStatement.body.rows).toEqual([]);
  });

  it('raises the next invoice on one press, with the standing amount and the account number', async () => {
    const { account } = await rental({ monthsAgo: 1 });
    const r = await h(request(app).post(`/api/accounts/${account.id}/next-invoice`)).send({});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ customerName: 'Jane', amountCents: 1_000_000, accountReference: account.fullNumber, invoiceName: 'Rent statement' });
    expect(r.body.billedPeriod).toBe(periodLabel('monthly'));
    // It went to Safaricom as an invoice, and nothing else was written: no payment row exists.
    expect(sendInvoice).toHaveBeenCalledTimes(1);
    expect((await deps.db.query(`SELECT 1 FROM requests WHERE type = ANY($1::text[])`, [['b2c', 'c2b']])).length).toBe(0);
    // An account with no standing amount is told so rather than invoiced for nothing.
    const bare = await rental({ name: 'Second House' });
    const plain = (await h(request(app).post(`/api/businesses/${bare.business.id}/accounts`)).send({ name: 'No amount' })).body;
    const refused = await h(request(app).post(`/api/accounts/${plain.id}/next-invoice`)).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('no_standing_amount');
  });

  it('writes the reminder for the owner to send, records it, and moves no money', async () => {
    const { account } = await rental({ monthsAgo: 3 });
    await recordC2b(deps, payment({ billRefNumber: account.fullNumber, amount: 10000 }), 'callback');
    const r = await h(request(app).post(`/api/accounts/${account.id}/remind`)).send({});
    expect(r.status).toBe(200);
    expect(r.body.owedCents).toBe(2_000_000);
    expect(r.body.phone).toBe('254700123456');
    expect(r.body.message).toContain('Jane');
    expect(r.body.message).toContain('KES 20,000');
    expect(r.body.message).toContain(account.fullNumber);
    expect(r.body.message).toContain('White House');
    // Recorded, and read back on the next statement.
    const [row] = await deps.db.query<{ last_reminded_at: Date | null }>('SELECT last_reminded_at FROM accounts WHERE id=$1', [account.id]);
    expect(row.last_reminded_at).not.toBeNull();
    const [log] = await deps.db.query<{ after_json: { owedCents: number } }>(`SELECT after_json FROM audit_log WHERE action='account.reminded' AND target=$1`, [account.id]);
    expect(log.after_json.owedCents).toBe(2_000_000);
    const after = await h(request(app).get(`/api/accounts/${account.id}/statement`));
    expect(after.body.lastRemindedAt).not.toBeNull();
    // Nothing moved: no send, no request row beyond the payment that was already there.
    expect(ack).not.toHaveBeenCalled();
    expect((await deps.db.query(`SELECT 1 FROM requests WHERE type = ANY($1::text[])`, [['b2c', 'reversal']])).length).toBe(0);
  });
});
