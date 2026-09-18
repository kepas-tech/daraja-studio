import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { DarajaAuthError } from '@kepas/daraja-js';
import { makeApp, resetTables } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Round 4: recovering the payer names.
 *
 * This paybill's confirmations go to another system, so Studio learns of those payments from the
 * pull, whose sender is the word MPESA. A status query by receipt returns DebitPartyName with the
 * real person, and the status handler writes it onto the row — the name alone.
 */
const SAF_IP = '196.201.214.200';
const status = vi.fn(async () => ({ conversationId: 'AG_L1', originatorConversationId: 'QL1', responseCode: '0', responseDescription: 'ok' }));
const daraja: DarajaFactory = {
  get: async () => ({}) as never,
  getForOperator: async () => ({ status: { transaction: status }, config: { initiator: 'APIONE' } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
};
const { app, deps, close } = makeApp({ daraja });
afterAll(async () => { await deps.events.stop(); await close(); });

async function ready() {
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status, rotated_at) VALUES ('APIONE',$1,'verified', now() - interval '84 days')`, [encrypt(deps.config.secretKey, 'c')]);
}

let n = 0;
async function paid(over: { name?: string | null; status?: string; type?: string; receipt?: string } = {}) {
  n += 1;
  const [r] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name, receipt, result_at)
     VALUES ($1,'Pay Bill',$2,$3,25000,'KES','phone','254712345678',$4,$5, now()) RETURNING id`,
    [over.type ?? 'c2b', 'OC-R4-' + n, over.status ?? 'completed', over.name === undefined ? 'MPESA' : over.name, over.receipt ?? 'RC' + String(n).padStart(8, '0')],
  );
  return { id: r!.id, receipt: over.receipt ?? 'RC' + String(n).padStart(8, '0') };
}

function statusBody(opts: { convId: string; debit?: string; receipt?: string } = { convId: 'AG_L1' }) {
  return { Result: {
    ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
    OriginatorConversationID: 'QL1', ConversationID: opts.convId, TransactionID: opts.receipt ?? 'RC00000001',
    ResultParameters: { ResultParameter: [
      { Key: 'DebitPartyName', Value: opts.debit ?? '254115599147 - Bazil Mwendwa Wambua' },
      { Key: 'CreditPartyName', Value: '600999 - KEPAS' },
      { Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'Amount', Value: 250 },
      { Key: 'ReceiptNo', Value: opts.receipt ?? 'RC00000001' }, { Key: 'FinalisedTime', Value: 20260906142000 },
      { Key: 'ReasonType', Value: 'Pay Bill' },
    ] },
  } };
}

describe('finding the missing payer names', () => {
  beforeEach(async () => { await resetTables(deps.db); status.mockClear(); await ready(); });

  it('picks exactly the payments whose name would show as nothing', async () => {
    const placeholder = await paid({ name: 'MPESA' });
    const empty = await paid({ name: null });
    await paid({ name: '254712345678 - JANE DOE' });          // a real name already
    await paid({ name: 'MPESA', status: 'failed' });          // never settled
    await paid({ name: 'MPESA', type: 'b2c' });               // money out, not a payer
    // A receipt asked about a moment ago is left alone: the answer may still be coming.
    const asked = await paid({ name: 'MPESA' });
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, sent_at, recipient_value)
      VALUES ('status_query','lookup','OC-ASKED','sent', now(), $1)`, [asked.receipt]);

    const found = await deps.nameBackfill.missing();
    expect(found.map((f) => f.id).sort()).toEqual([placeholder.id, empty.id].sort());
    expect(found[0]).not.toHaveProperty('recipient_name');
  });

  it('asks Safaricom by receipt, a handful at a time, and never on its own account', async () => {
    for (let i = 0; i < 6; i += 1) await paid({ name: 'MPESA' });
    const out = await deps.nameBackfill.ask({ limit: 3, gapMs: 0 });
    expect(out).toMatchObject({ asked: 3, skipped: 0, stopped: null });
    expect(out.remaining).toBe(3);
    expect(status).toHaveBeenCalledTimes(3);
    for (const call of status.mock.calls) {
      expect(call[0]).toMatchObject({ transactionId: expect.stringMatching(/^RC\d{8}$/), resultUrl: 'https://studio.example/cb/sekret/status' });
    }

    // Every query is a lookup with the subject recorded, and no person behind it: Studio asked.
    const queries = await deps.db.query<{ subtype: string; created_by: string | null; payload_json: { subject?: string }; recipient_value: string }>(
      `SELECT subtype, created_by, payload_json, recipient_value FROM requests WHERE type='status_query' ORDER BY created_at`);
    expect(queries).toHaveLength(3);
    for (const q of queries) {
      expect(q.subtype).toBe('lookup');
      expect(q.created_by).toBeNull();
      expect(q.payload_json.subject).toBe('name_fill');
    }
    const audit = await deps.db.query<{ person_id: string | null; action: string }>(`SELECT person_id, action FROM audit_log WHERE action='lookup.requested'`);
    expect(audit).toHaveLength(3);
    for (const a of audit) expect(a.person_id).toBeNull();

    // The next run leaves those three alone and picks up the rest.
    const second = await deps.nameBackfill.ask({ limit: 5, gapMs: 0 });
    expect(second).toMatchObject({ asked: 3, stopped: null });
    expect(second.remaining).toBe(0);
  });

  it('writes the payer name on the answer, and changes nothing else about the payment', async () => {
    const p = await paid({ name: 'MPESA' });
    const before = (await deps.db.query<{ status: string; amount_cents: string; receipt: string; result_at: Date }>('SELECT status, amount_cents, receipt, result_at FROM requests WHERE id=$1', [p.id]))[0]!;

    await deps.nameBackfill.ask({ limit: 1, gapMs: 0 });
    expect(status).toHaveBeenCalledTimes(1);

    // Safaricom's answer comes back on the status callback, keyed on the query's conversation id.
    const cb = await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody({ convId: 'AG_L1', receipt: p.receipt }));
    expect(cb.status).toBe(200);

    const after = (await deps.db.query<{ status: string; amount_cents: string; receipt: string; result_at: Date; recipient_name: string }>('SELECT status, amount_cents, receipt, result_at, recipient_name FROM requests WHERE id=$1', [p.id]))[0]!;
    expect(after.recipient_name).toBe('Bazil Mwendwa Wambua');   // the phone prefix is dropped
    expect(after.status).toBe(before.status);
    expect(after.amount_cents).toBe(before.amount_cents);
    expect(after.receipt).toBe(before.receipt);
    expect(after.result_at.getTime()).toBe(before.result_at.getTime());
  });

  it('never overwrites a name Studio already has', async () => {
    const p = await paid({ name: '254712345678 - JANE DOE', receipt: 'RC00000009' });
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, recipient_value, payload_json)
      VALUES ('status_query','lookup','OC-Q','AG_Q9','sent', now(), 'RC00000009', $1::jsonb)`,
      [JSON.stringify({ receipt: 'RC00000009' })]);
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody({ convId: 'AG_Q9', receipt: 'RC00000009', debit: '254115599147 - SOMEBODY ELSE' }));
    const [row] = await deps.db.query<{ recipient_name: string }>('SELECT recipient_name FROM requests WHERE id=$1', [p.id]);
    expect(row!.recipient_name).toBe('254712345678 - JANE DOE');
  });

  it('stops the run when the shared Daraja token is refused, and tries again next time', async () => {
    await paid({ name: 'MPESA' });
    await paid({ name: 'MPESA' });
    status.mockRejectedValueOnce(new DarajaAuthError('authentication failed (HTTP 401): Invalid Access Token'));
    const stopped = await deps.nameBackfill.ask({ limit: 5, gapMs: 0 });
    expect(stopped).toMatchObject({ asked: 0, stopped: 'auth' });
    expect(await deps.db.query(`SELECT 1 FROM requests WHERE type='status_query'`)).toHaveLength(0);
    // The other system minted a new token; the next run asks again and gets through.
    expect(await deps.nameBackfill.ask({ limit: 5, gapMs: 0 })).toMatchObject({ asked: 2, stopped: null });
  });

  it('offers the one press on Money in, with the count and the cap', async () => {
    // The owner logs in first: loginAsOwner resets the tables, so the payments come after it.
    const { loginAsOwner } = await import('./helpers.js');
    const cookie = await loginAsOwner(app, deps);
    await ready();
    await paid({ name: 'MPESA' });
    await paid({ name: null });

    const list = await request(app).get('/api/money-in/missing-names').set('Cookie', cookie.cookie);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ count: 2, perRun: 5 });

    const ask = await request(app).post('/api/money-in/find-names').set('Cookie', cookie.cookie).set('x-csrf-token', cookie.csrf).send({});
    expect(ask.status).toBe(200);
    expect(ask.body).toMatchObject({ asked: 2, remaining: 0 });
    expect((await deps.db.query(`SELECT 1 FROM requests WHERE type='status_query'`)).length).toBe(2);
  });
});
