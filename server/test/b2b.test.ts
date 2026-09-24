import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner, loginAs, makePerson, TEST_ORG_ID } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { encrypt } from '../src/crypto/secrets.js';
import { B2B_QUEUE_TIMEOUT } from '../src/callbacks/b2b.js';
import { BILLABLE_SEND_TYPES, KINDS, MONEY_TYPES } from '../src/money_out/registry.js';

const SAF_IP = '196.201.214.200';
// eslint-disable-next-line prefer-const -- forward-referenced by the fake's post closure, assigned once makeApp returns
let app: express.Express;
const fake = createFakeSafaricom({ post: async (path, body) => { await request(app).post(path).set('X-Forwarded-For', SAF_IP).send(body as object); } });
const made = makeApp({ fetchImpl: fake.fetchImpl });
app = made.app;
const { deps, close } = made;
afterAll(close);

const PASSWORD = 'correct horse';

async function ready() {
  await deps.settings.set('env.sandbox.shortcode', '600999');
  await deps.settings.set('daraja.environment', 'sandbox');
  await deps.settings.set('env.sandbox.consumerKey', 'k');
  await deps.settings.set('env.sandbox.consumerSecret', 's');
  await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('testapi',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'Y3JlZA==')]);
}

interface Row {
  id: string; type: string; subtype: string; status: string; amount_cents: string; recipient_kind: string; recipient_value: string; recipient_name: string | null;
  receipt: string | null; result_code: string | null; result_desc: string | null; meaning: string | null; result_source: string | null; result_at: Date | null;
  charge_cents: string | null; operator_id: string | null; payload_json: { accountReference?: string | null; ackOriginatorConversationId?: string };
}

/**
 * B2B on real PostgreSQL, through the fake only: no agent pays a real business.
 *
 *   1  a paybill is paid end to end: the call, the row, the result, the name Safaricom gives
 *   2  a till is paid with the Buy Goods command, and takes no account number
 *   3  nothing is written or sent without the password
 *   4  a paybill needs pay.paybill and a till pay.till
 *   5  the same paybill, account and amount twice is a duplicate; another account is not
 *   6  a refusal carries Safaricom's words and what the code means for B2B
 *   7  a queue timeout lands unknown, and the sweep resolves it
 *   8  a result posted to the phone address is never applied to a business payment
 *   9  the review asks Safaricom who the number belongs to
 *  10  the approval threshold holds a business payment, and release sends it
 *  11  a credential refusal goes out again with the next operator
 *  12  the kind is registered where money out is counted, swept and billed
 */
describe('B2B: pay a paybill or a till', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); fake.reset(); });

  const pay = (body: Record<string, unknown>, who = { cookie: '', csrf: '' }) => request(app).post('/api/send/business')
    .set('Cookie', who.cookie || cookie).set('x-csrf-token', who.csrf || csrf)
    .send({ to: 'paybill', shortcode: '888880', accountReference: 'METER42', amountCents: 50000, password: PASSWORD, ...body });
  const rowOf = async (id: string): Promise<Row> => (await deps.db.query<Row>('SELECT * FROM requests WHERE id=$1', [id]))[0]!;
  const b2bRows = () => deps.db.query<{ id: string }>(`SELECT id FROM requests WHERE type='b2b'`);
  const b2bCalls = () => fake.calls.filter((c) => c.path.endsWith('/b2b/v1/paymentrequest'));

  it('rule 1: pays a paybill end to end', async () => {
    const r = await pay({ remarks: 'March power' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('sent');
    const calls = b2bCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ CommandID: 'BusinessPayBill', RecieverIdentifierType: '4', PartyB: 888880, AccountReference: 'METER42', Amount: 500 });
    expect(String(calls[0].body.ResultURL)).toMatch(/\/cb\/sekret\/b2b$/);
    expect(String(calls[0].body.QueueTimeOutURL)).toMatch(/\/cb\/sekret\/b2b\/timeout$/);

    const before = await rowOf(r.body.id);
    expect(before).toMatchObject({ type: 'b2b', subtype: 'BusinessPayBill', recipient_kind: 'paybill', recipient_value: '888880' });
    expect(before.payload_json.accountReference).toBe('METER42');
    expect(before.charge_cents).not.toBeNull();
    expect((await deps.db.query(`SELECT 1 FROM audit_log WHERE action='request.created' AND target=$1`, [r.body.id])).length).toBe(1);

    await fake.settle();
    const after = await rowOf(r.body.id);
    expect(after.status).toBe('completed');
    expect(after.result_source).toBe('callback');
    expect(after.receipt).toMatch(/^RB/);
    // Safaricom's "888880 - ACME TRADERS", with the number dropped.
    expect(after.recipient_name).toBe('ACME TRADERS');
    const view = await request(app).get('/api/requests/' + r.body.id).set('Cookie', cookie);
    expect(view.body.accountReference).toBe('METER42');
  });

  it('rule 2: pays a till with Buy Goods, and refuses an account number for one', async () => {
    const bad = await pay({ to: 'till', shortcode: '123456', accountReference: 'X1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('till_no_account');
    expect(b2bCalls()).toHaveLength(0);

    const r = await pay({ to: 'till', shortcode: '123456', accountReference: undefined });
    expect(r.status).toBe(201);
    expect(b2bCalls()[0].body).toMatchObject({ CommandID: 'BusinessBuyGoods', RecieverIdentifierType: '2', PartyB: 123456 });
    expect(await rowOf(r.body.id)).toMatchObject({ subtype: 'BusinessBuyGoods', recipient_kind: 'till' });
  });

  it('rule 3: writes and sends nothing without the password', async () => {
    const r = await pay({ password: undefined });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('step_up_required');
    expect(await b2bRows()).toHaveLength(0);
    expect(b2bCalls()).toHaveLength(0);
  });

  it('rule 4: a paybill needs pay.paybill, a till needs pay.till', async () => {
    const id = await makePerson(deps.db, TEST_ORG_ID, { username: 'clerk', password: PASSWORD });
    await deps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'pay.paybill')`, [id]);
    const clerk = await loginAs(app, 'clerk', PASSWORD);
    const till = await pay({ to: 'till', shortcode: '123456', accountReference: undefined }, clerk);
    expect(till.status).toBe(403);
    expect(till.body.error.details.permission).toBe('pay.till');
    expect(await b2bRows()).toHaveLength(0);
    expect((await pay({}, clerk)).status).toBe(201);
  });

  it('rule 5: the same paybill, account and amount twice is a duplicate; another account is not', async () => {
    expect((await pay({})).status).toBe(201);
    const again = await pay({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('duplicate_recent');
    expect((await pay({ accountReference: 'METER43' })).status).toBe(201);
    expect((await pay({ confirmDuplicate: true })).status).toBe(201);
    expect(await b2bRows()).toHaveLength(3);
  });

  it("rule 6: a refusal carries Safaricom's words and what the code means for B2B", async () => {
    fake.rejectsSync('1', 'The balance is insufficient for the transaction.');
    const r = await pay({});
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('failed');
    const row = await rowOf(r.body.id);
    expect(row.result_code).toBe('1');
    expect(row.result_desc).toBe('The balance is insufficient for the transaction.');
    // Safaricom said / what it means (the SDK's catalogue) / what to do now (Studio's own line).
    expect(row.meaning).toBe('The sending (Working) account has insufficient funds. Fund it and retry.');
    const view = await request(app).get('/api/requests/' + r.body.id).set('Cookie', cookie);
    expect(view.body.whatToDo).toBe('The Working account does not have enough funds. Fund it, then try again.');
  });

  it('rule 7: a queue timeout lands unknown, and the sweep resolves it', async () => {
    fake.neverAnswers();
    const r = await pay({});
    const oc = (await rowOf(r.body.id)).payload_json.ackOriginatorConversationId!;
    expect(oc).toMatch(/^fake-b2b-/);
    const t = await request(app).post('/cb/sekret/b2b/timeout').set('X-Forwarded-For', SAF_IP).send({ Result: {
      ResultType: 1, ResultCode: 1, ResultDesc: 'The service request has timed out.', OriginatorConversationID: oc, ConversationID: 'AG_B2B',
    } });
    expect(t.status).toBe(200);
    const unknown = await rowOf(r.body.id);
    expect(unknown.status).toBe('unknown');
    expect(unknown.meaning).toBe(B2B_QUEUE_TIMEOUT);
    expect(unknown.result_at).toBeNull();

    fake.completes();
    await deps.db.query(`UPDATE requests SET sent_at = now() - interval '3 minutes' WHERE id=$1`, [r.body.id]);
    expect((await deps.moneyOut.sweep()).polled).toBe(1);
    expect(fake.calls.find((c) => c.path.endsWith('/transactionstatus/v1/query'))!.body.OriginatorConversationID).toBe(oc);
    await fake.settle();
    const done = await rowOf(r.body.id);
    expect(done.status).toBe('completed');
    expect(done.result_source).toBe('poll');
  });

  it('rule 8: a result posted to the phone address is never applied to a business payment', async () => {
    fake.neverAnswers();
    const r = await pay({});
    const oc = (await rowOf(r.body.id)).payload_json.ackOriginatorConversationId!;
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send({ Result: {
      ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', OriginatorConversationID: oc, ConversationID: 'AG_X', TransactionID: 'RBWRONG000',
    } });
    const row = await rowOf(r.body.id);
    expect(row.status).toBe('sent');
    expect(row.receipt).toBeNull();
  });

  it('rule 9: the review asks Safaricom who the number belongs to', async () => {
    const check = (body: Record<string, unknown>) => request(app).post('/api/send/business-check').set('Cookie', cookie).set('x-csrf-token', csrf).send(body);
    expect((await check({ to: 'paybill', shortcode: '888880' })).body).toEqual({ available: true, name: 'ACME TRADERS', paidBefore: false });
    fake.knowsShortcodeAs(false);
    expect((await check({ to: 'paybill', shortcode: '888880' })).body).toEqual({ available: false, reason: 'not_found', paidBefore: false });
    fake.knowsShortcodeAs(null);
    expect((await check({ to: 'paybill', shortcode: '888880' })).body).toEqual({ available: false, reason: 'unavailable', paidBefore: false });
    fake.reset();
    await pay({});
    expect((await check({ to: 'paybill', shortcode: '888880' })).body.paidBefore).toBe(true);
    expect((await check({ to: 'till', shortcode: '888880' })).body.paidBefore).toBe(false);
    expect((await check({ to: 'paybill', shortcode: '12' })).status).toBe(400);
  });

  it('rule 10: the approval threshold holds a business payment, and release sends it', async () => {
    await deps.settings.set('send.approvalThresholdCents', '50000');
    const r = await pay({});
    expect(r.body.status).toBe('awaiting_approval');
    expect(b2bCalls()).toHaveLength(0);
    const id = await makePerson(deps.db, TEST_ORG_ID, { username: 'approver', password: PASSWORD });
    await deps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'send.approve')`, [id]);
    const released = await deps.moneyOut.release(r.body.id, { personId: id, ip: '1.1.1.1' });
    expect(released.status).toBe('sent');
    expect(b2bCalls()).toHaveLength(1);
    await deps.settings.set('send.approvalThresholdCents', '0');
  });

  it('rule 11: a credential refusal goes out again with the next operator', async () => {
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('backupapi',$1,'verified',2)`, [encrypt(deps.config.secretKey, 'Y3JlZA==')]);
    fake.rejectsSync('2001', 'The initiator information is invalid.');
    const r = await pay({});
    expect(r.body.status).toBe('sent');
    const calls = b2bCalls();
    expect(calls.map((c) => c.body.Initiator)).toEqual(['testapi', 'backupapi']);
    await fake.settle();
    expect((await rowOf(r.body.id)).status).toBe('completed');
    expect(await b2bRows()).toHaveLength(1);
  });

  it('rule 12: the kind is registered where money out is counted, swept and billed', () => {
    expect(KINDS.b2b).toMatchObject({ scope: 'b2b', callbackPath: 'b2b', debits: 'working', recipient: 'shortcode', countsAsSend: true });
    expect(MONEY_TYPES).toContain('b2b');
    expect(BILLABLE_SEND_TYPES).toContain('b2b');
  });
});
