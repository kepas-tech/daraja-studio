import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { C2bPayment } from '@kepas/daraja-js';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { recordC2b } from '../src/money_in/record.js';
import { encrypt } from '../src/crypto/secrets.js';
import { SHIPPED_TYPES } from '../src/businesses/types.js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Round 3, phase B: what kind of business this is.
 *
 * A type is a row of data with a template — the words and the shape of that kind of money — seeded
 * into the organisation and editable by the owner. These tests read the seeded nine, create and
 * change a business's type, edit a type's words, and check the one promise that matters: changing
 * the kind of business changes words and nothing else.
 */

const ack = async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_1', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'ok' });
const daraja: DarajaFactory = { get: async () => ({ b2c: { send: ack } }) as never, getForOperator: async () => ({ b2c: { send: ack }, config: { initiator: 'APIONE' } }) as never, invalidate: () => {}, stkEnabled: async () => false };
const { app, deps, close } = makeApp({ daraja });
afterAll(close);

let receiptSeq = 0;
const payment = (over: Partial<C2bPayment> = {}): C2bPayment => ({
  transactionType: 'Pay Bill', transId: ('R' + String(++receiptSeq).padStart(9, '0')).slice(0, 10),
  transTime: '20260916101530', amount: 250, shortCode: '600999', billRefNumber: '000123',
  invoiceNumber: '', thirdPartyTransId: '', msisdn: '254700123456', firstName: 'Jane', middleName: '', lastName: 'Doe', ...over,
});

describe('business types', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => {
    await resetTables(deps.db);
    ({ cookie, csrf } = await loginAsOwner(app, deps));
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
  });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const types = async () => (await h(request(app).get('/api/business-types'))).body.items as { key: string; name: string; template: Record<string, unknown> }[];
  const addBusiness = async (name: string, typeKey?: string) => (await h(request(app).post('/api/businesses')).send({ name, ...(typeKey ? { typeKey } : {}) })).body;

  it('seeds the nine kinds of business, each with its own template', async () => {
    const items = await types();
    expect(items.map((t) => t.key)).toEqual([...SHIPPED_TYPES.map((t) => t.key)]);
    const rental = items.find((t) => t.key === 'rental')!;
    expect(rental.name).toBe('Rental or property');
    expect(rental.template).toMatchObject({ accountNoun: 'Tenant', subAccountNoun: 'Room or unit', regular: 'monthly', standingAmount: 'fixed', invoices: 'on', reminders: true, homeLead: 'behind', statementNoun: 'Rent statement' });
    expect(rental.template.categories).toEqual(['Rent', 'Deposit', 'Water', 'Penalty']);
    // The neutral one turns nothing on, which is what a business with no type gets.
    const other = items.find((t) => t.key === 'other')!;
    expect(other.template).toMatchObject({ accountNoun: 'Account', subAccountNoun: null, regular: 'no', standingAmount: 'none', invoices: 'off', reminders: false, homeLead: 'nothing' });
    // Reading it twice does not double the rows.
    expect((await types()).length).toBe(9);
  });

  it('asks for the kind of business as the business is made, and carries its words back', async () => {
    const made = await addBusiness('White House', 'rental');
    expect(made.type.key).toBe('rental');
    expect(made.type.template.accountNoun).toBe('Tenant');
    const unnamed = await addBusiness('Corner Shop');
    expect(unnamed.type.key).toBe('other');
    expect(unnamed.type.template.accountNoun).toBe('Account');
    const bad = await h(request(app).post('/api/businesses')).send({ name: 'Nope', typeKey: 'hospital' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('unknown_type');
    expect((await deps.db.query('SELECT 1 FROM businesses')).length).toBe(2);
  });

  it('changes the kind of business without losing a shilling of history', async () => {
    const b = await addBusiness('White House', 'rental');
    const account = (await h(request(app).post(`/api/businesses/${b.id}/accounts`)).send({ name: 'Jane' })).body;
    const paid = await recordC2b(deps, payment({ billRefNumber: account.fullNumber }), 'callback');
    const before = (await deps.db.query<{ business_id: string; account_id: string; amount_cents: string; receipt: string }>(
      'SELECT business_id, account_id, amount_cents, receipt FROM requests WHERE id=$1', [paid.requestId]))[0];

    const changed = await h(request(app).put(`/api/businesses/${b.id}/type`)).send({ typeKey: 'school' });
    expect(changed.status).toBe(200);
    expect(changed.body.type.key).toBe('school');
    expect(changed.body.type.template.accountNoun).toBe('Student');

    // The account, its number and the payment are exactly what they were.
    const accountAfter = (await deps.db.query<{ number: string; full_number: string; name: string }>('SELECT number, full_number, name FROM accounts WHERE id=$1', [account.id]))[0];
    expect(accountAfter).toEqual({ number: account.number, full_number: account.fullNumber, name: 'Jane' });
    const after = (await deps.db.query<{ business_id: string; account_id: string; amount_cents: string; receipt: string }>(
      'SELECT business_id, account_id, amount_cents, receipt FROM requests WHERE id=$1', [paid.requestId]))[0];
    expect(after).toEqual(before);
    // And the change is in the record, with both words.
    const [log] = await deps.db.query<{ before_json: { type: string }; after_json: { type: string } }>(
      `SELECT before_json, after_json FROM audit_log WHERE action='business.type_changed' AND target=$1`, [b.id]);
    expect(log.before_json.type).toBe('rental');
    expect(log.after_json.type).toBe('school');
    // The list agrees, and an unknown kind is refused.
    expect((await h(request(app).get('/api/businesses'))).body.items[0].type.key).toBe('school');
    expect((await h(request(app).put(`/api/businesses/${b.id}/type`)).send({ typeKey: 'hospital' })).status).toBe(400);
  });

  it('edits a type in place, and every business of that kind reads the new words', async () => {
    const b = await addBusiness('White House', 'rental');
    const rental = (await types()).find((t) => t.key === 'rental')!;
    const edited = await h(request(app).put('/api/business-types/rental')).send({
      name: 'Rental (flats)', template: { ...rental.template, accountNoun: 'Mpangaji', statementNoun: 'Rent book' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.template.accountNoun).toBe('Mpangaji');
    const listed = (await h(request(app).get('/api/businesses'))).body.items.find((x: { id: string }) => x.id === b.id);
    expect(listed.type.name).toBe('Rental (flats)');
    expect(listed.type.template.statementNoun).toBe('Rent book');
    const [log] = await deps.db.query<{ before_json: { accountNoun: string }; after_json: { accountNoun: string } }>(
      `SELECT before_json, after_json FROM audit_log WHERE action='business_type.edited' AND target='rental'`);
    expect(log.before_json.accountNoun).toBe('Tenant');
    expect(log.after_json.accountNoun).toBe('Mpangaji');
  });

  it('takes a kind of business the owner invents, with no deploy', async () => {
    const made = await h(request(app).post('/api/business-types')).send({
      name: 'Car wash',
      template: { accountNoun: 'Attendant', subAccountNoun: 'Bay', regular: 'weekly', standingAmount: 'fixed', categories: ['Wash', 'Detailing'], invoices: 'off', reminders: false, homeLead: 'takings', statementNoun: 'Wash record' },
    });
    expect(made.status).toBe(201);
    expect(made.body.key).toBe('car_wash');
    const b = await addBusiness('Wash Point', made.body.key);
    expect(b.type.template.accountNoun).toBe('Attendant');
    // A half-filled template is refused rather than stored half-shaped.
    const bad = await h(request(app).post('/api/business-types')).send({ name: 'Half', template: { accountNoun: 'Thing' } });
    expect(bad.status).toBe(400);
  });

  it('refuses to delete a kind that businesses still use, and deletes one that nobody uses', async () => {
    await addBusiness('White House', 'rental');
    const refused = await h(request(app).del('/api/business-types/rental')).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('type_in_use');
    expect((await types()).some((t) => t.key === 'rental')).toBe(true);
    const gone = await h(request(app).del('/api/business-types/transport')).send({});
    expect(gone.status).toBe(204);
    expect((await types()).some((t) => t.key === 'transport')).toBe(false);
  });

  it('keeps writing to businesses.manage, and the day summary carries each business its own words', async () => {
    const b = await addBusiness('White House', 'rental');
    await h(request(app).post(`/api/businesses/${b.id}/accounts`)).send({ name: 'Jane' });
    const summary = await h(request(app).get('/api/businesses/summary'));
    expect(summary.status).toBe(200);
    expect(summary.body.items[0]).toMatchObject({ businessId: b.id, accountCount: 1 });
    expect(summary.body.items[0].type.template.accountNoun).toBe('Tenant');
  });
});
