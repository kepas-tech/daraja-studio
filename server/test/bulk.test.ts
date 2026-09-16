import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { parseBulk } from '../src/money_out/bulkParse.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { encrypt } from '../src/crypto/secrets.js';
import { DarajaAPIError } from '@kepas/daraja-js';

describe('parseBulk', () => {
  it('reads commas, tabs, quotes, a header and blank lines; names the bad lines', () => {
    const { rows, errors } = parseBulk('phone,amount,name,note\n0700123456,1500,"Doe, Jane",Rent\n\n254700123457\t250\tJohn\n0700123458,12.50\nnonsense,5\n0700123456,1500,again\n0700123459,0\n');
    expect(rows.map((r) => [r.phone, r.amountCents, r.name, r.note])).toEqual([['254700123456', 150000, 'Doe, Jane', 'Rent'], ['254700123457', 25000, 'John', null]]);
    expect(errors).toEqual([
      { line: 5, message: 'Whole shillings only. Safaricom does not send cents to phones.' },
      { line: 6, message: 'Not a Kenyan mobile number.' },
      { line: 7, message: 'Same phone and amount as line 2.' },
      { line: 8, message: 'The amount must be more than zero.' },
    ]);
  });
  it('a first line that is a real row is not a header', () => {
    expect(parseBulk('0700123456,100').rows.length).toBe(1);
  });
});

const ack = vi.fn(async (input: { originatorConversationId: string; phone: string }) => ({ conversationId: 'AG_1', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
const factory: DarajaFactory = {
  get: async () => ({ b2c: { send: ack } }) as never,
  getForOperator: async () => ({ b2c: { send: ack }, config: { initiator: 'APIONE' } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
} as unknown as DarajaFactory;

describe('bulk send', () => {
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
  const TEXT = '0700123456,100,Jane,Rent\n0700123457,200,John\n0700123458,300';

  it('check reports rows, errors and the total without writing anything', async () => {
    const r = await h(request(app).post('/api/send/bulk/check')).send({ text: TEXT + '\nbad,1' });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    expect(r.body.totalCents).toBe(60000);
    expect(r.body.errors).toEqual([{ line: 4, message: 'Not a Kenyan mobile number.' }]);
    expect((await deps.db.query('SELECT 1 FROM bulk_plans')).length).toBe(0);
  });

  it('a batch with one bad row creates nothing', async () => {
    const r = await h(request(app).post('/api/send/bulk')).send({ text: TEXT + '\nbad,1', password: 'correct horse' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bulk_invalid');
    expect((await deps.db.query('SELECT 1 FROM bulk_plans')).length).toBe(0);
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
  });

  it('creates the plan, queues the drain, and the drain sends every row in order as ordinary requests', async () => {
    const r = await h(request(app).post('/api/send/bulk')).send({ text: TEXT, password: 'correct horse' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('sending');
    expect(r.body.rowCount).toBe(3);
    expect((await deps.db.query(`SELECT 1 FROM jobs WHERE kind='bulk_send' AND done_at IS NULL`)).length).toBe(1);
    await deps.bulk.drain(r.body.id);
    expect(ack).toHaveBeenCalledTimes(3);
    const rows = await deps.db.query<{ recipient_value: string; amount_cents: string; status: string; bulk_plan_id: string; idx: string }>(
      `SELECT recipient_value, amount_cents, status, bulk_plan_id, payload_json->>'bulkIndex' AS idx FROM requests WHERE type='b2c' ORDER BY created_at`);
    expect(rows.map((x) => [x.recipient_value, x.amount_cents, x.status, x.idx])).toEqual([['254700123456', '10000', 'sent', '0'], ['254700123457', '20000', 'sent', '1'], ['254700123458', '30000', 'sent', '2']]);
    expect(rows.every((x) => x.bulk_plan_id === r.body.id)).toBe(true);
    const view = await request(app).get(`/api/send/bulk/${r.body.id}`).set('Cookie', s.cookie);
    expect(view.body.status).toBe('done');
    expect(view.body.rows.map((x: { liveStatus: string }) => x.liveStatus)).toEqual(['sent', 'sent', 'sent']);
    // Running the drain again sends nothing twice.
    await deps.bulk.drain(r.body.id);
    expect(ack).toHaveBeenCalledTimes(3);
  });

  it('a refused row is recorded and the batch goes on; retry re-queues only retriable failures', async () => {
    // Row 2 duplicates a send made a minute ago outside the batch: refused before Safaricom, not retriable.
    await h(request(app).post('/api/send/phone')).send({ phone: '0700123457', amountCents: 20000, commandId: 'BusinessPayment', password: 'correct horse' });
    ack.mockClear();
    // Row 1 is refused by Safaricom itself (a real request row, failed); not a credential code, so the operator stays.
    ack.mockImplementationOnce(async () => { throw new DarajaAPIError('The balance is insufficient for the transaction.', { resultCode: 1, resultDesc: 'The balance is insufficient for the transaction.', scope: 'b2c' }); });
    const r = await h(request(app).post('/api/send/bulk')).send({ text: TEXT, password: 'correct horse' });
    expect(r.status).toBe(201);
    await deps.bulk.drain(r.body.id);
    const view = (await request(app).get(`/api/send/bulk/${r.body.id}`).set('Cookie', s.cookie)).body;
    expect(view.status).toBe('partly_done');
    expect(view.rows[0].liveStatus).toBe('failed');
    expect(view.rows[1].result).toMatchObject({ status: 'failed', retriable: false });
    expect(view.rows[1].liveStatus).toBeNull();
    expect(view.rows[2].liveStatus).toBe('sent');
    // Nothing left that can be tried again: the Safaricom refusal has its own request row (Send again lives there), the duplicate is final.
    const retry = await h(request(app).post(`/api/send/bulk/${r.body.id}/retry`)).send({ password: 'correct horse' });
    expect(retry.status).toBe(409);
  });

  it('a row refused before Safaricom for a passing reason is tried again on Retry', async () => {
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    const r = await h(request(app).post('/api/send/bulk')).send({ text: TEXT, password: 'correct horse' });
    // The studio refuses every row before Safaricom (the public address vanished mid-batch), then it is back.
    await deps.settings.delete('public.url');
    await deps.bulk.drain(r.body.id);
    let view = (await request(app).get(`/api/send/bulk/${r.body.id}`).set('Cookie', s.cookie)).body;
    expect(view.status).toBe('partly_done');
    expect(view.rows.every((x: { result: { status: string; retriable: boolean } }) => x.result.status === 'failed' && x.result.retriable)).toBe(true);
    expect(ack).not.toHaveBeenCalled();
    await deps.settings.set('public.url', 'https://studio.example');
    const retry = await h(request(app).post(`/api/send/bulk/${r.body.id}/retry`)).send({ password: 'correct horse' });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('sending');
    await deps.bulk.drain(r.body.id);
    view = (await request(app).get(`/api/send/bulk/${r.body.id}`).set('Cookie', s.cookie)).body;
    expect(view.status).toBe('done');
    expect(ack).toHaveBeenCalledTimes(3);
  });

  it('holds rows at or above the approval threshold instead of sending them', async () => {
    await deps.settings.set('send.approvalThresholdCents', '25000');
    const r = await h(request(app).post('/api/send/bulk')).send({ text: TEXT, password: 'correct horse' });
    await deps.bulk.drain(r.body.id);
    expect(ack).toHaveBeenCalledTimes(2);
    const view = (await request(app).get(`/api/send/bulk/${r.body.id}`).set('Cookie', s.cookie)).body;
    expect(view.rows.map((x: { liveStatus: string }) => x.liveStatus)).toEqual(['sent', 'sent', 'awaiting_approval']);
    expect(view.status).toBe('done');
  });

  it('needs the permission and the password', async () => {
    expect((await h(request(app).post('/api/send/bulk')).send({ text: TEXT })).status).toBe(403);
    expect((await request(app).get('/api/send/bulk')).status).toBe(401);
  });
});
