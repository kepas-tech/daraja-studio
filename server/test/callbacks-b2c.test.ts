import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, resetTables } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import { createMoneyOutService, B2C_QUEUE_TIMEOUT } from '../src/money_out/service.js';
import type { DarajaFactory } from '../src/sdk/client.js';

const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });
const SAF_IP = '196.201.214.200';

function b2cTimeoutBody(oc: string) {
  return { Result: { ResultType: 1, ResultCode: 1, ResultDesc: 'The service request has timed out.', OriginatorConversationID: oc, ConversationID: `AG_${oc}` } };
}

function b2cBody(oc: string, code = 0) {
  const ok = code === 0;
  return { Result: {
    ResultType: 0, ResultCode: code, ResultDesc: ok ? 'The service request is processed successfully.' : 'The initiator information is invalid.',
    OriginatorConversationID: oc, ConversationID: `AG_${oc}`, TransactionID: ok ? 'RI6BZTPXNM' : '',
    ...(ok ? { ResultParameters: { ResultParameter: [
      { Key: 'TransactionAmount', Value: 1 }, { Key: 'TransactionReceipt', Value: 'RI6BZTPXNM' },
      { Key: 'B2CRecipientIsRegisteredCustomer', Value: 'Y' }, { Key: 'B2CChargesPaidAccountAvailableFunds', Value: 0 },
      { Key: 'ReceiverPartyPublicName', Value: '254700123456 - Jane Doe' }, { Key: 'TransactionCompletedDateTime', Value: '06.09.2026 14:20:00' },
      { Key: 'B2CUtilityAccountAvailableFunds', Value: 34391 }, { Key: 'B2CWorkingAccountAvailableFunds', Value: 14 },
    ] } } : {}),
    ReferenceData: { ReferenceItem: { Key: 'QueueTimeoutURL', Value: 'https://studio.example/cb/sekret/b2c' } },
  } };
}

async function seed(oc: string, status = 'sent') {
  const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('APIONE', $1, 'verified') RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
  const [req] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, operator_id, sent_at) VALUES ('b2c','BusinessPayment',$1,$2,100,'phone','254700123456',$3,now()) RETURNING id`, [oc, status, op.id]);
  return { opId: op.id, reqId: req.id };
}

describe('/cb/b2c', () => {
  const seen: { type: string; payload: unknown }[] = [];
  beforeEach(async () => {
    await resetTables(deps.db);
    seen.length = 0;
  });

  it('completes the request with receipt and name, stores the funds as a balances row, publishes events', async () => {
    const { reqId } = await seed('OCB1');
    const unsub = deps.events.subscribe((e) => seen.push(e));
    await deps.events.start();
    try {
      const r = await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCB1'));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
      const [row] = await deps.db.query<{ status: string; receipt: string; recipient_name: string; result_source: string; conversation_id: string }>('SELECT status, receipt, recipient_name, result_source, conversation_id FROM requests WHERE id=$1', [reqId]);
      expect(row.status).toBe('completed');
      expect(row.receipt).toBe('RI6BZTPXNM');
      expect(row.recipient_name).toBe('254700123456 - Jane Doe');
      expect(row.result_source).toBe('callback');
      expect(row.conversation_id).toBe('AG_OCB1');
      const [bal] = await deps.db.query<{ utility_cents: string; working_cents: string; charges_paid_cents: string | null }>('SELECT utility_cents, working_cents, charges_paid_cents FROM balances');
      expect(Number(bal.utility_cents)).toBe(3439100);
      expect(Number(bal.working_cents)).toBe(1400);
      expect(bal.charges_paid_cents).toBeNull();
      const [raw] = await deps.db.query<{ verdict: string; matched_request_id: string }>('SELECT verdict, matched_request_id FROM callbacks_raw');
      expect(raw.verdict).toBe('applied');
      expect(raw.matched_request_id).toBe(reqId);
      await new Promise((r) => setTimeout(r, 200));
      expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(['request.updated', 'balance.updated']));
    } finally { unsub(); await deps.events.stop(); }
  });

  it('a credential failure marks the request failed with three lines and the operator failed', async () => {
    const { reqId, opId } = await seed('OCB2');
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCB2', 2001));
    const [row] = await deps.db.query<{ status: string; result_code: string; result_desc: string; meaning: string }>('SELECT status, result_code, result_desc, meaning FROM requests WHERE id=$1', [reqId]);
    expect(row.status).toBe('failed');
    expect(row.result_code).toBe('2001');
    expect(row.result_desc).toBe('The initiator information is invalid.');
    expect(row.meaning).toBeTruthy();
    const [op] = await deps.db.query<{ status: string; last_error: string }>('SELECT status, last_error FROM operators WHERE id=$1', [opId]);
    expect(op.status).toBe('failed');
    expect(op.last_error).toMatch(/initiator information/);
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(0);
  });

  it('an unknown request (connection error earlier) is finalised by a late callback', async () => {
    const { reqId } = await seed('OCB3', 'unknown');
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCB3'));
    const [row] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [reqId]);
    expect(row.status).toBe('completed');
  });

  it('duplicate and unmatched verdicts', async () => {
    await seed('OCB4');
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCB4'));
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCB4'));
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('NOPE'));
    const verdicts = (await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw ORDER BY received_at')).map((r) => r.verdict);
    expect(verdicts).toEqual(['applied', 'duplicate', 'unmatched']);
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(1);
  });

  it('a b2c result never touches a balance request with the same id shape', async () => {
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OCB5','sent')`);
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCB5'));
    const [row] = await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OCB5'`);
    expect(row.status).toBe('sent');
    expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('unmatched');
  });

  it('a pending row (crash before our own sent update) is completed by its result', async () => {
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('APIONE', $1, 'verified') RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    const [req] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, operator_id) VALUES ('b2c','BusinessPayment','OCB6','pending',100,'phone','254700123456',$1) RETURNING id`, [op.id]);
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCB6'));
    const [row] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [req.id]);
    expect(row.status).toBe('completed');
  });

  // Under SDK 1.4.1 the B2C call goes over the v1 endpoint and Safaricom assigns its own
  // OriginatorConversationID, which the send path stores as payload_json->>'ackOriginatorConversationId'.
  // The result callback echoes Safaricom's id, not ours, so matching must fall back to that field.
  it('matches on the acknowledged OriginatorConversationID stored in payload_json when it differs from ours', async () => {
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('APIONE', $1, 'verified') RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    const [req] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, operator_id, sent_at, payload_json)
       VALUES ('b2c','BusinessPayment','ours-1','sent',100,'phone','254700123456',$1,now(),$2::jsonb) RETURNING id`,
      [op.id, JSON.stringify({ ackOriginatorConversationId: 'SAF-1' })]);
    const r = await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('SAF-1'));
    expect(r.status).toBe(200);
    const [row] = await deps.db.query<{ status: string; receipt: string }>('SELECT status, receipt FROM requests WHERE id=$1', [req.id]);
    expect(row.status).toBe('completed');
    expect(row.receipt).toBe('RI6BZTPXNM');
  });
});

describe('/cb/b2c/timeout', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
  });

  it('marks the row unknown (never failed), leaves it pollable, and does not finalise it', async () => {
    const { reqId } = await seed('OCT1');
    const r = await request(app).post('/cb/sekret/b2c/timeout').set('X-Forwarded-For', SAF_IP).send(b2cTimeoutBody('OCT1'));
    expect(r.status).toBe(200);
    const [row] = await deps.db.query<{ status: string; meaning: string; poll_attempts: number; result_at: Date | null; result_code: string | null; result_source: string | null }>(
      'SELECT status, meaning, poll_attempts, result_at, result_code, result_source FROM requests WHERE id=$1', [reqId]);
    expect(row.status).toBe('unknown');
    expect(row.meaning).toBe(B2C_QUEUE_TIMEOUT);
    expect(row.poll_attempts).toBe(0);
    expect(row.result_at).toBeNull();
    expect(row.result_code).toBeNull();
    expect(row.result_source).toBeNull();
    const [raw] = await deps.db.query<{ verdict: string; matched_request_id: string }>('SELECT verdict, matched_request_id FROM callbacks_raw');
    expect(raw.verdict).toBe('applied');
    expect(raw.matched_request_id).toBe(reqId);
  });

  it('the real Completed result that follows still applies and completes the row', async () => {
    const { reqId } = await seed('OCT2');
    await request(app).post('/cb/sekret/b2c/timeout').set('X-Forwarded-For', SAF_IP).send(b2cTimeoutBody('OCT2'));
    const r = await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCT2'));
    expect(r.status).toBe(200);
    const [row] = await deps.db.query<{ status: string; result_source: string; receipt: string }>('SELECT status, result_source, receipt FROM requests WHERE id=$1', [reqId]);
    expect(row.status).toBe('completed');
    expect(row.result_source).toBe('callback');
    expect(row.receipt).toBe('RI6BZTPXNM');
  });

  it('a timeout for a row already completed is a duplicate and leaves it untouched', async () => {
    const { reqId } = await seed('OCT3');
    await request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody('OCT3'));
    const before = (await deps.db.query('SELECT status, receipt, result_at FROM requests WHERE id=$1', [reqId]))[0];
    const r = await request(app).post('/cb/sekret/b2c/timeout').set('X-Forwarded-For', SAF_IP).send(b2cTimeoutBody('OCT3'));
    expect(r.status).toBe(200);
    const [raw] = await deps.db.query<{ verdict: string }>("SELECT verdict FROM callbacks_raw WHERE path='b2c/timeout'");
    expect(raw.verdict).toBe('duplicate');
    const after = (await deps.db.query('SELECT status, receipt, result_at FROM requests WHERE id=$1', [reqId]))[0];
    expect(after).toEqual(before);
  });

  it('sweep() polls the row after a timeout notification once it has aged past 2 minutes', async () => {
    const { reqId } = await seed('OCT4');
    await deps.db.query(`UPDATE requests SET sent_at = now() - interval '3 minutes' WHERE id=$1`, [reqId]);
    await request(app).post('/cb/sekret/b2c/timeout').set('X-Forwarded-For', SAF_IP).send(b2cTimeoutBody('OCT4'));
    const statusAck = vi.fn(async () => ({ conversationId: 'AG_Q', originatorConversationId: 'q-1', responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
    const daraja: DarajaFactory = {
      get: async () => ({}) as never,
      getForOperator: async () => ({ status: { transaction: statusAck }, config: { initiator: 'APIONE' } }) as never,
      invalidate: () => {}, stkEnabled: async () => false,
    };
    const svc = createMoneyOutService({ ...deps, daraja, events: deps.events });
    expect(await svc.sweep()).toEqual({ polled: 1, expired: 0 });
    expect(statusAck).toHaveBeenCalledWith(expect.objectContaining({ originatorConversationId: 'OCT4' }));
  });
});
