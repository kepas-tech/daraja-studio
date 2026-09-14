import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, resetTables } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });
const SAF_IP = '196.201.214.200';

/** Safaricom's own STK envelope: metadata items are named `Name`, not B2C's `Key`. */
function stkBody(checkoutId: string, opts: { code?: number; receipt?: string } = {}) {
  const code = opts.code ?? 0;
  const ok = code === 0;
  return { Body: { stkCallback: {
    MerchantRequestID: `MR_${checkoutId}`, CheckoutRequestID: checkoutId,
    ResultCode: code, ResultDesc: ok ? 'The service request is processed successfully.' : 'Request cancelled by user',
    ...(ok ? { CallbackMetadata: { Item: [
      { Name: 'Amount', Value: 1 },
      { Name: 'MpesaReceiptNumber', Value: opts.receipt ?? 'RI6BZTPXNM' },
      { Name: 'TransactionDate', Value: 20260914143000 },
      { Name: 'PhoneNumber', Value: 254700123456 },
    ] } } : {}),
  } } };
}

/** A tenant's own payment request, in the shape the collect service leaves it: Safaricom named it
 *  with a CheckoutRequestID, which is kept as the ack identifier the callback is matched on. */
async function seedAsk(checkoutId: string, status = 'sent') {
  const [req] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, remarks, payload_json, sent_at)
     VALUES ('stk',NULL,gen_random_uuid(),$1,100,'phone','254700123456','INV-7',$2::jsonb,now()) RETURNING id`,
    [status, JSON.stringify({ accountReference: 'INV-7', description: 'Payment', ackOriginatorConversationId: checkoutId })]);
  return req!.id;
}

const post = (body: unknown, path = '/cb/sekret/stk') => request(app).post(path).set('X-Forwarded-For', SAF_IP).send(body);

describe('/cb/stk — an organisation asking its own customer to pay', () => {
  beforeEach(async () => { await resetTables(deps.db); });

  it('the customer paid: the row completes with the receipt Safaricom gave', async () => {
    const id = await seedAsk('ws_CO_A1');
    const r = await post(stkBody('ws_CO_A1'));
    expect(r.status).toBe(200);
    const [row] = await deps.db.query<{ status: string; receipt: string; result_source: string; conversation_id: string }>(
      'SELECT status, receipt, result_source, conversation_id FROM requests WHERE id=$1', [id]);
    expect(row!.status).toBe('completed');
    expect(row!.receipt).toBe('RI6BZTPXNM');
    expect(row!.result_source).toBe('callback');
    expect(row!.conversation_id).toBe('MR_ws_CO_A1');
  });

  it('the customer refused: the row fails carrying Safaricom\'s own words', async () => {
    const id = await seedAsk('ws_CO_A2');
    await post(stkBody('ws_CO_A2', { code: 1032 }));
    const [row] = await deps.db.query<{ status: string; result_code: string; result_desc: string; meaning: string }>(
      'SELECT status, result_code, result_desc, meaning FROM requests WHERE id=$1', [id]);
    expect(row!.status).toBe('failed');
    expect(row!.result_code).toBe('1032');
    expect(row!.result_desc).toBe('Request cancelled by user');
    // Three lines, never merged: Safaricom's text is kept as it came, the meaning comes from the
    // SDK's own catalog for the stk scope.
    expect(row!.meaning).toBeTruthy();
    expect(row!.meaning).not.toBe(row!.result_desc);
  });

  it('answered twice: the second delivery changes nothing and is still accepted', async () => {
    const id = await seedAsk('ws_CO_A3');
    await post(stkBody('ws_CO_A3'));
    const [first] = await deps.db.query<{ result_at: Date }>('SELECT result_at FROM requests WHERE id=$1', [id]);
    const again = await post(stkBody('ws_CO_A3', { receipt: 'DIFFERENT1' }));
    expect(again.status).toBe(200);
    const [row] = await deps.db.query<{ status: string; receipt: string; result_at: Date }>('SELECT status, receipt, result_at FROM requests WHERE id=$1', [id]);
    expect(row!.status).toBe('completed');
    expect(row!.receipt).toBe('RI6BZTPXNM');
    expect(row!.result_at.getTime()).toBe(first!.result_at.getTime());
  });

  it('answered after we gave up: a row already held as unknown is settled by the late callback', async () => {
    const id = await seedAsk('ws_CO_A4', 'unknown');
    await post(stkBody('ws_CO_A4'));
    const [row] = await deps.db.query<{ status: string; receipt: string }>('SELECT status, receipt FROM requests WHERE id=$1', [id]);
    expect(row!.status).toBe('completed');
    expect(row!.receipt).toBe('RI6BZTPXNM');
  });

  it('a checkout reference we never issued touches nothing', async () => {
    const id = await seedAsk('ws_CO_A5');
    const r = await post(stkBody('ws_CO_UNKNOWN'));
    expect(r.status).toBe(200);
    const [row] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [id]);
    expect(row!.status).toBe('sent');
  });

  it('the same result posted to the send address is never applied', async () => {
    const id = await seedAsk('ws_CO_A6');
    await post(stkBody('ws_CO_A6'), '/cb/sekret/b2c');
    const [row] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [id]);
    expect(row!.status).toBe('sent');
  });

  it('the raw body is stored whatever the verdict', async () => {
    await seedAsk('ws_CO_A7');
    await post(stkBody('ws_CO_UNKNOWN2'));
    const rows = await deps.db.query<{ verdict: string }>(`SELECT verdict FROM callbacks_raw WHERE path='stk'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('unmatched');
  });
});
