import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { DarajaAPIError, DarajaAuthError, DarajaConnectionError } from '@kepas/daraja-js';
import { makeApp, loginAsOwner } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { dailyHandler } from '../src/scheduler/handlers.js';

const SAF_IP = '196.201.214.200';

const balanceQuery = vi.fn(async () => ({ conversationId: 'AG_B', originatorConversationId: `bal-${Math.random().toString(36).slice(2)}`, responseCode: '0', responseDescription: 'ok' }));
const transaction = vi.fn(async () => ({ conversationId: 'AG_S', originatorConversationId: `st-${Math.random().toString(36).slice(2)}`, responseCode: '0', responseDescription: 'ok' }));
const daraja: DarajaFactory = { get: async () => ({}) as never, getForOperator: async () => ({ balance: { query: balanceQuery }, status: { transaction }, config: { initiator: 'KEPAS' } }) as never, invalidate: () => {}, stkEnabled: async () => false };
const { app, deps, close } = makeApp({ daraja });
afterAll(close);

async function ready() {
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status, rotated_at) VALUES ('KEPAS',$1,'verified', now() - interval '84 days')`, [encrypt(deps.config.secretKey, 'c')]);
}

// A Safaricom balance RESULT — as opposed to the synchronous ack — carrying whichever ids the
// original ack echoed back (I2: a uuid-fallback refresh row's own OriginatorConversationID never
// reached Safaricom, so its result can only ever carry the ConversationID Safaricom itself issued).
function balanceResultBody(originatorConversationId: string, conversationId: string) {
  return { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
    OriginatorConversationID: originatorConversationId, ConversationID: conversationId, TransactionID: 'X',
    ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Working Account|KES|14.00|14.00|0.00|0.00&Utility Account|KES|34392.00|34392.00|0.00|0.00&Charges Paid Account|KES|0.00|0.00|0.00|0.00' }] } } };
}

describe('balances and lookup', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); balanceQuery.mockClear(); transaction.mockClear(); });

  it('latest is null, then the newest snapshot', async () => {
    let r = await request(app).get('/api/balances/latest').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    await deps.db.query(`INSERT INTO balances(working_cents, utility_cents, charges_paid_cents, raw, queried_at) VALUES (100, 200, 0, '{}', now() - interval '1 day'), (1400, 3439100, NULL, '{}', now())`);
    r = await request(app).get('/api/balances/latest').set('Cookie', cookie);
    expect(r.body.utilityCents).toBe(3439100);
    expect(r.body.workingCents).toBe(1400);
    expect(r.body.chargesPaidCents).toBeNull();
    expect(typeof r.body.queriedAt).toBe('string');
  });

  it('refresh needs money-ready, sends a balance query, records a sent balance row and a timeout job, and refuses a second in flight', async () => {
    let r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(409);
    await ready();
    r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(202);
    expect(balanceQuery).toHaveBeenCalledWith(expect.objectContaining({ resultUrl: 'https://studio.example/cb/sekret/balance' }));
    const [row] = await deps.db.query<{ type: string; subtype: string; status: string }>('SELECT type, subtype, status FROM requests WHERE id=$1', [r.body.requestId]);
    expect(row).toEqual({ type: 'balance', subtype: 'refresh', status: 'sent' });
    expect((await deps.db.query(`SELECT 1 FROM jobs WHERE kind='request_timeout' AND payload->>'requestId'=$1`, [r.body.requestId]))).toHaveLength(1);
    // W7: a one-shot timeout job (max_attempts 1) leaves the row "Sent, waiting" forever if the
    // single attempt hits a transient DB error; the handler's own `WHERE status='sent'` already
    // makes a retry idempotent, so the job itself must be allowed to retry.
    expect((await deps.db.query<{ max_attempts: number }>(`SELECT max_attempts FROM jobs WHERE kind='request_timeout' AND payload->>'requestId'=$1`, [r.body.requestId]))[0].max_attempts).toBe(3);
    expect((await deps.db.query(`SELECT 1 FROM audit_log WHERE action='balance.refreshed' AND target=$1`, [r.body.requestId]))).toHaveLength(1);
    r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('refresh_in_flight');
  });

  // I1: refreshBalance is the daily job's only line of defence — the HTTP route's own
  // requireMoneyReady never runs for it — so it must refuse on its own before ever building a
  // Daraja client or reaching Safaricom.
  it('refreshBalance refuses before Safaricom is proven reachable', async () => {
    await expect(deps.moneyOut.refreshBalance(null)).rejects.toMatchObject({ status: 409, code: 'public_url_unverified' });
    expect(balanceQuery).not.toHaveBeenCalled();
  });

  // Decision 3: Safaricom's ack can come back with an empty OriginatorConversationID. That
  // column is UNIQUE NOT NULL, so a naive store would either crash or collide with a second
  // empty-id ack — the row must fall back to a studio uuid instead. I2: that fallback row can
  // only ever be matched back to a result by conversation_id, since its own OriginatorConversationID
  // is a studio uuid Safaricom never saw.
  it('a refresh ack with an empty OriginatorConversationID still gets a safe row, and its own result can still complete it', async () => {
    await ready();
    balanceQuery.mockResolvedValueOnce({ conversationId: 'AG_EMPTY_1', originatorConversationId: '', responseCode: '0', responseDescription: 'ok' });
    let r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(202);
    const [row] = await deps.db.query<{ status: string; originator_conversation_id: string; conversation_id: string }>(
      'SELECT status, originator_conversation_id, conversation_id FROM requests WHERE id=$1', [r.body.requestId]);
    expect(row.status).toBe('sent');
    expect(row.originator_conversation_id).toBeTruthy();
    expect(row.conversation_id).toBe('AG_EMPTY_1');

    const cb = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceResultBody('', 'AG_EMPTY_1'));
    expect(cb.status).toBe(200);
    const [after] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [r.body.requestId]);
    expect(after.status).toBe('completed');
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(1);

    // A second empty-ack refresh (the row above is now 'completed', so no in-flight guard blocks
    // it) must still get its own safe row — no collision between two studio-uuid fallbacks.
    balanceQuery.mockResolvedValueOnce({ conversationId: 'AG_EMPTY_2', originatorConversationId: '', responseCode: '0', responseDescription: 'ok' });
    r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(202);
  });

  // I3 + M1: decision 4's rejection taxonomy, exercised through the one route that can trigger
  // each SDK error class, and the catalog meaning riding alongside Safaricom's own text.
  it('refreshBalance turns each kind of SDK rejection into the studio\'s plain-English 502, and never writes a row', async () => {
    await ready();
    const countBalanceRows = async () => (await deps.db.query(`SELECT 1 FROM requests WHERE type='balance'`)).length;
    const before = await countBalanceRows();

    balanceQuery.mockRejectedValueOnce(new DarajaAuthError('OAuth token request failed (HTTP 401)'));
    let r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('daraja_auth');
    expect(r.body.error.message).toBe('OAuth token request failed (HTTP 401)');

    balanceQuery.mockRejectedValueOnce(new DarajaAPIError('rejected', { raw: { ResponseCode: '2001', ResponseDescription: 'The initiator information is invalid.' } }));
    r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('safaricom_rejected');
    expect(r.body.error.message).toBe('The initiator information is invalid.');
    expect(r.body.error.details).toMatchObject({ safaricomSaid: 'The initiator information is invalid.' });
    expect(typeof r.body.error.details.meaning).toBe('string');

    balanceQuery.mockRejectedValueOnce(new DarajaConnectionError('network error reaching Daraja'));
    r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('safaricom_unreachable');

    expect(await countBalanceRows()).toBe(before);
  });

  // Carry-over: a rejection that is none of DarajaAuthError/DarajaAPIError/DarajaConnectionError
  // is a programming error, not a Safaricom outcome — it must surface as the standard 500, never
  // be mislabelled safaricom_unreachable (which would hide a real bug behind a Safaricom-shaped error).
  it('a non-SDK rejection surfaces as the standard 500, not a mislabelled 502', async () => {
    await ready();
    balanceQuery.mockRejectedValueOnce(new TypeError('boom'));
    const r = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('internal');
  });

  it('lookup validates the receipt, sends a status query by receipt, records a lookup row keyed like a poll target', async () => {
    await ready();
    let r = await request(app).post('/api/lookup').set('Cookie', cookie).set('x-csrf-token', csrf).send({ receipt: 'bad receipt' });
    expect(r.status).toBe(400);
    r = await request(app).post('/api/lookup').set('Cookie', cookie).set('x-csrf-token', csrf).send({ receipt: 'ri6bztpxnm' });
    expect(r.status).toBe(202);
    expect(transaction).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'RI6BZTPXNM', resultUrl: 'https://studio.example/cb/sekret/status' }));
    const ack = await transaction.mock.results[0].value;
    const [row] = await deps.db.query<{
      type: string; subtype: string; status: string; recipient_value: string;
      originator_conversation_id: string; conversation_id: string; payload_json: { receipt: string; ackOriginatorConversationId: string };
    }>('SELECT type, subtype, status, recipient_value, originator_conversation_id, conversation_id, payload_json FROM requests WHERE id=$1', [r.body.requestId]);
    expect(row.type).toBe('status_query');
    expect(row.subtype).toBe('lookup');
    expect(row.status).toBe('sent');
    expect(row.recipient_value).toBe('RI6BZTPXNM');
    expect(row.payload_json).toMatchObject({ receipt: 'RI6BZTPXNM' });
    // Keyed like pollTarget's own rows : our own id, never Safaricom's echoed one, which
    // is a shared key across every outstanding query and would collide with the UNIQUE column.
    expect(row.originator_conversation_id).not.toBe(ack.originatorConversationId);
    expect(row.conversation_id).toBe(ack.conversationId);
    expect((await deps.db.query<{ max_attempts: number }>(`SELECT max_attempts FROM jobs WHERE kind='request_timeout' AND payload->>'requestId'=$1`, [r.body.requestId]))[0].max_attempts).toBe(3);
    expect((await deps.db.query(`SELECT 1 FROM audit_log WHERE action='lookup.requested' AND target=$1`, [r.body.requestId]))).toHaveLength(1);
  });

  // M6: a repeat click for the same receipt must not be free to hit Safaricom's Transaction
  // Status API on every request — lookup.view carries no cooldown of its own.
  it('lookup refuses a second request for the same receipt within two minutes', async () => {
    await ready();
    let r = await request(app).post('/api/lookup').set('Cookie', cookie).set('x-csrf-token', csrf).send({ receipt: 'ri6bztpxnm' });
    expect(r.status).toBe(202);
    expect(transaction).toHaveBeenCalledTimes(1);
    r = await request(app).post('/api/lookup').set('Cookie', cookie).set('x-csrf-token', csrf).send({ receipt: 'RI6BZTPXNM' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('lookup_in_flight');
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  // I1: the daily job's own refresh half must honour the whole money-ready gate, not just
  // urls()'s narrower "public.url is set" check — the studio's own ngrok workflow clears
  // public.verifiedAt on every address change until a fresh Test succeeds, and the job must not
  // reach Safaricom in that gap.
  it("the daily job's refresh half skips until the studio is fully money-ready, then runs, then skips again while in flight", async () => {
    const daily = dailyHandler({ db: deps.db, settings: deps.settings, events: deps.events, moneyOut: deps.moneyOut });
    await daily({}, { id: 'j', kind: 'daily', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
    expect(balanceQuery).not.toHaveBeenCalled();
    await deps.settings.set('public.url', 'https://studio.example');
    await daily({}, { id: 'j', kind: 'daily', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
    expect(balanceQuery).not.toHaveBeenCalled();
    await ready();
    await daily({}, { id: 'j', kind: 'daily', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
    expect(balanceQuery).toHaveBeenCalledTimes(1);
    await daily({}, { id: 'j', kind: 'daily', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
    expect(balanceQuery).toHaveBeenCalledTimes(1);
  });

  // M3 + M9: exact days, Kenyan calendar day, and no re-alerting a second tick the same day.
  it('the daily job alerts on operator passwords expiring in exactly 7 or 3 days, once per Kenyan calendar day', async () => {
    const seen: { kind: string; daysLeft: number }[] = [];
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert' && (e.payload as { kind: string }).kind === 'operator_password_expiring') seen.push(e.payload as { kind: string; daysLeft: number }); });
    await deps.events.start();
    try {
      const enc = encrypt(deps.config.secretKey, 'c');
      await deps.db.query(
        `INSERT INTO operators(name, credential_enc, status, rotated_at) VALUES
           ('OP8',$1,'verified', (((now() AT TIME ZONE 'Africa/Nairobi')::date - 82)::timestamp AT TIME ZONE 'Africa/Nairobi')),
           ('OP7',$1,'verified', (((now() AT TIME ZONE 'Africa/Nairobi')::date - 83)::timestamp AT TIME ZONE 'Africa/Nairobi')),
           ('OP3',$1,'verified', (((now() AT TIME ZONE 'Africa/Nairobi')::date - 87)::timestamp AT TIME ZONE 'Africa/Nairobi')),
           ('OP2',$1,'verified', (((now() AT TIME ZONE 'Africa/Nairobi')::date - 88)::timestamp AT TIME ZONE 'Africa/Nairobi'))`,
        [enc]);
      const daily = dailyHandler({ db: deps.db, settings: deps.settings, events: deps.events, moneyOut: deps.moneyOut });
      await daily({}, { id: 'j', kind: 'daily', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
      await new Promise((r) => setTimeout(r, 200));
      expect(seen.map((p) => p.daysLeft).sort((a, b) => a - b)).toEqual([3, 7]);

      seen.length = 0;
      await daily({}, { id: 'j', kind: 'daily', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toEqual([]);
    } finally { unsub(); await deps.events.stop(); }
  });
});
