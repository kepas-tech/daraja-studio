import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { C2bPayment } from '@kepas/daraja-js';
import { makeApp, loginAsOwner, loginAs, makePerson, resetTables, TEST_ORG_ID } from './helpers.js';
import { createAdminPool, withSystem } from '../src/db/pool.js';
import { recordC2b } from '../src/money_in/record.js';
import { parseAccount } from '../src/businesses/match.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Feature 2: the three-digit business code in front of an account number, the customer numbers
 * Studio mints, and the one-click fixes on Money in. Real PostgreSQL throughout; the only Safaricom
 * in sight is the in-process ack below, so nothing here can move money.
 */

const ack = vi.fn(async (input: { originatorConversationId: string }) => ({
  conversationId: 'AG_1', originatorConversationId: input.originatorConversationId,
  responseCode: '0', responseDescription: 'Accept the service request successfully.',
}));
const factory: DarajaFactory = {
  get: async () => ({ b2c: { send: ack } }) as never,
  getForOperator: async () => ({ b2c: { send: ack }, config: { initiator: 'APIONE' } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
} as unknown as DarajaFactory;

const eatDay = (offsetDays = 0) => new Date(Date.now() + 3 * 3_600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);
let receiptSeq = 0;
const payment = (over: Partial<C2bPayment> = {}): C2bPayment => ({
  transactionType: 'Pay Bill', transId: ('R' + String(++receiptSeq).padStart(9, '0')).slice(0, 10),
  transTime: eatDay().replace(/-/g, '') + '120000', amount: 100, shortCode: '600999',
  billRefNumber: '000123', invoiceNumber: '', thirdPartyTransId: '',
  msisdn: '254700123456', firstName: 'Jane', middleName: '', lastName: 'Doe', ...over,
});

describe('parseAccount — the rule, with no database', () => {
  const one = [{ id: 'b0', code: '000' }];
  const two = [{ id: 'b0', code: '000' }, { id: 'b1', code: '001' }];

  it('no businesses: nothing is decided', () => {
    expect(parseAccount('123', [])).toEqual({ businessId: null, candidates: [], unmatched: false });
  });
  it('one business owns everything, and reads 123 and 000123 the same way', () => {
    expect(parseAccount('123', one)).toEqual({ businessId: 'b0', candidates: [123], unmatched: false });
    expect(parseAccount('000123', one)).toEqual({ businessId: 'b0', candidates: [123], unmatched: false });
  });
  it('one business: a reference that is only its code means the business, no customer', () => {
    expect(parseAccount('000', one)).toEqual({ businessId: 'b0', candidates: [], unmatched: false });
  });
  it('one business: a non-numeric reference is still that business, never unmatched', () => {
    expect(parseAccount('12x', one)).toEqual({ businessId: 'b0', candidates: [], unmatched: false });
  });
  it('two businesses: the code picks the business and the rest is the customer', () => {
    expect(parseAccount('001123', two)).toEqual({ businessId: 'b1', candidates: [123], unmatched: false });
    expect(parseAccount('0010123', two)).toEqual({ businessId: 'b1', candidates: [123], unmatched: false });
    expect(parseAccount('001', two)).toEqual({ businessId: 'b1', candidates: [], unmatched: false });
  });
  it('two businesses: an unknown code, a short reference or letters after the code are unmatched', () => {
    expect(parseAccount('999123', two)).toEqual({ businessId: null, candidates: [], unmatched: true });
    expect(parseAccount('12', two)).toEqual({ businessId: null, candidates: [], unmatched: true });
    expect(parseAccount('12x', two)).toEqual({ businessId: null, candidates: [], unmatched: true });
    expect(parseAccount('00112x', two)).toEqual({ businessId: null, candidates: [], unmatched: true });
    expect(parseAccount(null, two)).toEqual({ businessId: null, candidates: [], unmatched: true });
  });
});

describe('businesses and customers', () => {
  const { app, deps, close } = makeApp({ daraja: factory });
  afterAll(close);
  let s: { cookie: string; csrf: string };
  beforeEach(async () => {
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.settings.set('env.sandbox.consumerKey', 'k');
    await deps.settings.set('env.sandbox.consumerSecret', 's');
    await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
    await deps.settings.set('env.sandbox.shortcode', '600999');
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
    ack.mockClear();
  });
  const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
  const addBusiness = async (name: string, code?: string) => (await h(request(app).post('/api/businesses')).send(code ? { name, code } : { name })).body;
  const addCustomer = async (businessId: string, name: string, extra: Record<string, unknown> = {}) =>
    (await h(request(app).post(`/api/businesses/` + businessId + `/customers`)).send({ name, ...extra })).body;

  it('the database itself refuses a two-digit code, a duplicate code and a duplicate customer number', async () => {
    await addBusiness('Shop');
    await expect(deps.db.query(`INSERT INTO businesses(code, name) VALUES ('12','Bad')`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(deps.db.query(`INSERT INTO businesses(code, name) VALUES ('000','Same code')`))
      .rejects.toMatchObject({ code: '23505' });
    const b = await addBusiness('Second', '001');
    await deps.db.query(`INSERT INTO customers(business_id, number, name) VALUES ($1, 7, 'Seven')`, [b.id]);
    await expect(deps.db.query(`INSERT INTO customers(business_id, number, name) VALUES ($1, 7, 'Seven again')`, [b.id]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('offers 000 then 001, takes an explicit free code, and refuses a used one', async () => {
    expect((await addBusiness('First')).code).toBe('000');
    expect((await addBusiness('Second')).code).toBe('001');
    expect((await addBusiness('Seventh', '007')).code).toBe('007');
    const taken = await h(request(app).post('/api/businesses')).send({ name: 'Clash', code: '007' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('code_taken');
    const list = await h(request(app).get('/api/businesses'));
    expect(list.body.items.map((b: { code: string }) => b.code)).toEqual(['000', '001', '007']);
    expect(list.body.lastUsedId).toBeNull();
  });

  it('mints 0, 1, 2 and never reuses a retired number', async () => {
    const b = await addBusiness('Shop');
    const first = await addCustomer(b.id, 'Jane');
    expect(first).toMatchObject({ number: 0, display: '000', accountNumber: '000000' });
    const second = await addCustomer(b.id, 'John');
    expect(second.accountNumber).toBe('000001');
    const third = await addCustomer(b.id, 'Mary', { phone: '0712 345 678' });
    expect(third).toMatchObject({ number: 2, accountNumber: '000002', phone: '254712345678' });
    const retired = await h(request(app).delete(`/api/customers/` + second.id));
    expect(retired.status).toBe(204);
    const list = await h(request(app).get(`/api/businesses/` + b.id + `/customers`));
    expect(list.body.items.map((c: { display: string }) => c.display)).toEqual(['000', '002']);
    const fourth = await addCustomer(b.id, 'A new customer');
    expect(fourth).toMatchObject({ number: 3, display: '003', accountNumber: '000003' });
  });

  it('grows to four digits only after all one thousand are used', async () => {
    const b = await addBusiness('Shop');
    await deps.db.query(`INSERT INTO customers(business_id, number, name) SELECT $1, g, 'Customer ' || g FROM generate_series(0, 999) g`, [b.id]);
    const next = await addCustomer(b.id, 'The thousand and first');
    expect(next).toMatchObject({ number: 1000, display: '1000', accountNumber: '0001000' });
  });

  it('one business: 123 and 000123 both land on customer 123', async () => {
    const b = await addBusiness('Shop');
    // Customer 123 has to exist for 123 to mean anybody: claim it, the way the fix on Money in does.
    const c = (await h(request(app).post(`/api/businesses/` + b.id + `/customers/claim`)).send({ number: 123, name: 'Jane' })).body;
    for (const ref of ['123', '000123', '0123']) {
      const row = await recordC2b(deps, payment({ billRefNumber: ref }), 'callback');
      const [r] = await deps.db.query<{ business_id: string; customer_id: string }>(`SELECT business_id, customer_id FROM requests WHERE id=$1`, [row.requestId]);
      expect(r.business_id).toBe(b.id);
      expect(r.customer_id).toBe(c.id);
    }
  });

  it('two businesses: the code decides, and the three unmatched shapes are told apart', async () => {
    const b0 = await addBusiness('First');
    const b1 = await addBusiness('Second', '001');
    const customer = (await h(request(app).post(`/api/businesses/` + b1.id + `/customers/claim`)).send({ number: 123, name: 'Jane' })).body;
    const seen = async (ref: string) => {
      const row = await recordC2b(deps, payment({ billRefNumber: ref }), 'callback');
      const [r] = await deps.db.query<{ business_id: string | null; customer_id: string | null }>(`SELECT business_id, customer_id FROM requests WHERE id=$1`, [row.requestId]);
      return r;
    };
    expect(await seen('001123')).toEqual({ business_id: b1.id, customer_id: customer.id });
    expect(await seen('999123')).toEqual({ business_id: null, customer_id: null });
    expect(await seen('12x')).toEqual({ business_id: null, customer_id: null });
    // A known code with nothing after it is a payment to the business, not an unmatched row.
    expect(await seen('001')).toEqual({ business_id: b1.id, customer_id: null });
    expect(await seen('000')).toEqual({ business_id: b0.id, customer_id: null });
  });

  it('lists unmatched rows flat, and each fix labels the row without touching amount or receipt', async () => {
    await addBusiness('First');
    const b1 = await addBusiness('Second', '001');
    const unknownCode = await recordC2b(deps, payment({ billRefNumber: '999123', amount: 250 }), 'callback');
    const unknownCustomer = await recordC2b(deps, payment({ billRefNumber: '001123', amount: 500 }), 'callback');

    const before = await h(request(app).get('/api/money-in/unmatched'));
    expect(before.status).toBe(200);
    const items = before.body.items as Record<string, unknown>[];
    expect(items.length).toBe(2);
    // Two rows recorded in the same second share created_at, so pick them out by reason, never by
    // position.
    const noCustomer = items.find((i) => i.reason === 'no_customer')!;
    const noBusiness = items.find((i) => i.reason === 'no_business')!;
    expect(noCustomer).toMatchObject({ reason: 'no_customer', businessId: b1.id, customerNumber: 123, accountReference: '001123', businessName: 'Second', amountCents: 50000 });
    expect(noBusiness).toMatchObject({ reason: 'no_business', businessId: null, customerNumber: null, accountReference: '999123' });
    // Flat, exactly as agreed: no nested business object, and the ordinary RequestView fields are there.
    expect('business' in noCustomer).toBe(false);
    expect(typeof noCustomer.id).toBe('string');
    expect(typeof noCustomer.createdAt).toBe('string');
    expect((noCustomer.recipient as { value: string }).value).toBe('254700123456');

    // Fix one: create the customer the payer already typed, then label the row with it.
    const claimed = await h(request(app).post(`/api/businesses/` + b1.id + `/customers/claim`)).send({ number: 123, name: 'Jane' });
    expect(claimed.status).toBe(201);
    expect(claimed.body.accountNumber).toBe('001123');
    const assigned = await h(request(app).post(`/api/businesses/assign/` + unknownCustomer.requestId)).send({ businessId: b1.id, customerId: claimed.body.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ customerName: 'Jane', businessName: 'Second', amountCents: 50000 });

    // Fix two: the code nobody owned is assigned to a business as it stands.
    const assigned2 = await h(request(app).post(`/api/businesses/assign/` + unknownCode.requestId)).send({ businessId: b1.id });
    expect(assigned2.status).toBe(200);
    expect(assigned2.body.businessName).toBe('Second');

    // Nothing about the money changed, and both decisions are on the record.
    const rows = await deps.db.query<{ id: string; amount_cents: string; receipt: string | null }>(`SELECT id, amount_cents, receipt FROM requests WHERE id = ANY($1)`, [[unknownCode.requestId, unknownCustomer.requestId]]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(Number(byId.get(unknownCode.requestId)!.amount_cents)).toBe(25000);
    expect(Number(byId.get(unknownCustomer.requestId)!.amount_cents)).toBe(50000);
    expect(byId.get(unknownCustomer.requestId)!.receipt).toBeTruthy();
    const audits = await deps.db.query(`SELECT action, target FROM audit_log WHERE action='money_in.assigned' ORDER BY id`);
    expect(audits.map((a) => a.target).sort()).toEqual([unknownCode.requestId, unknownCustomer.requestId].sort());
    // And nothing waits for a decision any more: both rows carry the business the owner chose.
    expect((await h(request(app).get('/api/money-in/unmatched'))).body.items.length).toBe(0);
  });

  it('refuses an assign that is not a c2b row, and one that names a business that is not there', async () => {
    const b = await addBusiness('Shop');
    const row = await recordC2b(deps, payment({ billRefNumber: '000123' }), 'callback');
    const send = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, password: 'correct horse' });
    expect(send.status).toBe(201);
    const notC2b = await h(request(app).post(`/api/businesses/assign/` + send.body.id)).send({ businessId: b.id });
    expect(notC2b.status).toBe(400);
    expect(notC2b.body.error.code).toBe('not_c2b');
    const missing = await h(request(app).post(`/api/businesses/assign/` + row.requestId)).send({ businessId: '00000000-0000-4000-8000-0000000000ff' });
    expect(missing.status).toBe(404);
  });

  it('a send carries the business, remembers it, and refuses an unknown or switched-off one', async () => {
    const b = await addBusiness('Shop');
    const off = await addBusiness('Closed', '001');
    await h(request(app).put(`/api/businesses/` + off.id)).send({ name: 'Closed', active: false });

    const sent = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, businessId: b.id, password: 'correct horse' });
    expect(sent.status).toBe(201);
    const [row] = await deps.db.query<{ business_id: string | null }>(`SELECT business_id FROM requests WHERE id=$1`, [sent.body.id]);
    expect(row.business_id).toBe(b.id);
    expect((await h(request(app).get('/api/businesses'))).body.lastUsedId).toBe(b.id);

    const unknown = await h(request(app).post('/api/send/phone')).send({ phone: '0700123457', amountCents: 10000, businessId: '00000000-0000-4000-8000-0000000000ff', password: 'correct horse' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('unknown_business');
    const inactive = await h(request(app).post('/api/send/phone')).send({ phone: '0700123458', amountCents: 10000, businessId: off.id, password: 'correct horse' });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('business_inactive');
    expect((await deps.db.query(`SELECT 1 FROM requests WHERE recipient_value = ANY($1)`, [['254700123457', '254700123458']])).length).toBe(0);
  });

  it('refuses another organisation\u2019s business before anything is written', async () => {
    // orgs is not the application role's table: the second organisation is seeded and removed on a
    // privileged connection, the same way helpers.ts seeds organisation #1.
    const otherOrg = '00000000-0000-4000-8000-000000000002';
    const admin = createAdminPool(process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@127.0.0.1:5434/studio_test');
    try {
      await withSystem(() => admin.query(`INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc) VALUES ($1,'other','Other','verified',false,'unused','unset') ON CONFLICT (id) DO NOTHING`, [otherOrg]));
      const [foreign] = await withSystem(() => admin.query<{ id: string }>(`INSERT INTO businesses(org_id, code, name) VALUES ($1,'000','Theirs') RETURNING id`, [otherOrg]));
      const r = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, businessId: foreign.id, password: 'correct horse' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('unknown_business');
      expect((await deps.db.query(`SELECT 1 FROM requests`)).length).toBe(0);
    } finally {
      await withSystem(() => admin.query(`DELETE FROM orgs WHERE id=$1`, [otherOrg]));
      await admin.end();
    }
  });

  it('a bulk batch carries its business into every row', async () => {
    const b = await addBusiness('Shop');
    const created = await h(request(app).post('/api/send/bulk')).send({ text: '0700123456,100,Jane\n0700123457,200,John', businessId: b.id, password: 'correct horse' });
    expect(created.status).toBe(201);
    expect(created.body.businessId).toBe(b.id);
    await deps.bulk.drain(created.body.id);
    const rows = await deps.db.query<{ business_id: string | null }>(`SELECT business_id FROM requests WHERE bulk_plan_id=$1`, [created.body.id]);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.business_id === b.id)).toBe(true);
  });

  it('summarises in and out per business for the day asked about', async () => {
    const b0 = await addBusiness('First');
    const b1 = await addBusiness('Second', '001');
    await addCustomer(b0.id, 'Jane');
    await recordC2b(deps, payment({ billRefNumber: '000123', amount: 300 }), 'callback');
    await recordC2b(deps, payment({ billRefNumber: '001123', amount: 500 }), 'callback');
    const sent = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 12000, businessId: b0.id, password: 'correct horse' });
    expect(sent.status).toBe(201);

    const today = await h(request(app).get('/api/businesses/summary'));
    expect(today.status).toBe(200);
    expect(Object.keys(today.body)).toEqual(['items']);
    const items = today.body.items as { businessId: string; code: string; name: string; inCents: number; outCents: number }[];
    expect(items.map((i) => i.code)).toEqual(['000', '001']);
    expect(items[0]).toMatchObject({ businessId: b0.id, name: 'First', inCents: 30000, outCents: 12000 });
    expect(items[1]).toMatchObject({ businessId: b1.id, name: 'Second', inCents: 50000, outCents: 0 });
    expect(typeof items[0].inCents).toBe('number');
    // A day with nothing in it reports zeroes rather than disappearing.
    const other = await h(request(app).get('/api/businesses/summary?day=2020-01-01'));
    expect(other.body.items.map((i: { inCents: number; outCents: number }) => [i.inCents, i.outCents])).toEqual([[0, 0], [0, 0]]);
  });

  it('lets anyone signed in read, and only businesses.manage write', async () => {
    const b = await addBusiness('Shop');
    const viewerId = await makePerson(deps.db, TEST_ORG_ID, { username: 'viewer', password: 'a long enough one', role: 'viewer' });
    expect(viewerId).toBeTruthy();
    const v = await loginAs(app, 'viewer', 'a long enough one');
    const vh = (r: request.Test) => r.set('Cookie', v.cookie).set('x-csrf-token', v.csrf);
    expect((await vh(request(app).get('/api/businesses'))).status).toBe(200);
    expect((await vh(request(app).get(`/api/businesses/` + b.id + `/customers`))).status).toBe(200);
    const refused = await vh(request(app).post('/api/businesses')).send({ name: 'Nope' });
    expect(refused.status).toBe(403);
    const refusedCustomer = await vh(request(app).post(`/api/businesses/` + b.id + `/customers`)).send({ name: 'Nope' });
    expect(refusedCustomer.status).toBe(403);
  });
});
