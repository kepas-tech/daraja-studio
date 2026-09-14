import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { encrypt } from '../src/crypto/secrets.js';
import { ALREADY_REVERSED, NOT_SETTLED, REVERSAL_QUEUE_TIMEOUT, SPENT_MEANING, createReversalService } from '../src/money_out/reversal.js';
import { KINDS, MONEY_TYPES } from '../src/money_out/registry.js';
import type { DarajaFactory } from '../src/sdk/client.js';

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
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('testapi',$1,'verified')`, [encrypt(deps.config.secretKey, 'Y3JlZA==')]);
}

interface ReversalRow {
  id: string; type: string; status: string; amount_cents: string | null; recipient_kind: string | null; recipient_value: string | null;
  receipt: string | null; result_at: Date | null; result_code: string | null; result_source: string | null; meaning: string | null;
  payload_json: { reversalOfRequestId?: string; ackOriginatorConversationId?: string };
}

/**
 * M3 on real PostgreSQL, through the fake only: no agent reverses a real payment.
 *
 * Each test names the rule it pins:
 *   1  a settled payment can be reversed, end to end
 *   2  a receipt that never settled is refused before Safaricom is called
 *   3  one receipt becomes exactly one reversal even when two are pressed at once
 *   4  a refusal carries Safaricom's own words, and a spent-funds refusal says so honestly
 *   5  a queue timeout lands unknown and the sweep resolves it
 *   6  the kind is registered where money out is counted
 *   7  a failed attempt does not burn the receipt, because nothing was reversed
 */
describe('M3: reverse a payment', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); fake.reset(); });

  const sendPhone = (extra: Record<string, unknown> = {}) => request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf)
    .send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment', password: PASSWORD, ...extra });
  const reverse = (receipt: string, extra: Record<string, unknown> = {}) => request(app).post('/api/send/reversal').set('Cookie', cookie).set('x-csrf-token', csrf)
    .send({ receipt, password: PASSWORD, ...extra });
  const findPayment = (receipt: string) => request(app).get('/api/send/reversal/' + receipt).set('Cookie', cookie);
  const rowOf = async (id: string): Promise<ReversalRow> => (await deps.db.query<ReversalRow>('SELECT * FROM requests WHERE id=$1', [id]))[0]!;
  const reversalRows = () => deps.db.query<{ id: string; status: string }>(`SELECT id, status FROM requests WHERE type='reversal' ORDER BY created_at`);
  const reversalCalls = () => fake.calls.filter((c) => c.path.endsWith('/reversal/v1/request'));
  const latestBalance = async () => (await deps.db.query<{ utility_cents: string | null }>('SELECT utility_cents FROM balances ORDER BY queried_at DESC LIMIT 1'))[0];

  /** A payment that really settled: sent through the app, answered by the fake, completed. */
  async function settledSend(amountCents = 100) {
    const r = await sendPhone({ amountCents });
    expect(r.status).toBe(201);
    await fake.settle();
    const [s] = await deps.db.query<{ id: string; receipt: string; status: string }>('SELECT id, receipt, status FROM requests WHERE id=$1', [r.body.id]);
    expect(s.status).toBe('completed');
    return s;
  }

  it('rule 1: reverses a settled payment end to end, one call, result applied', async () => {
    const settled = await settledSend(100);

    // The pre-check names the payment and the amount before a password is asked.
    const f = await findPayment(settled.receipt);
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ requestId: settled.id, receipt: settled.receipt, amountCents: 100 });

    // Step-up is required: a reversal is irreversible, so the password is not optional.
    const noPw = await request(app).post('/api/send/reversal').set('Cookie', cookie).set('x-csrf-token', csrf).send({ receipt: settled.receipt });
    expect(noPw.status).toBe(403);
    expect(noPw.body.error.code).toBe('step_up_required');
    expect(await reversalRows()).toHaveLength(0);

    const r = await reverse(settled.receipt);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('sent');
    const calls = reversalCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ TransactionID: settled.receipt, Amount: 1, CommandID: 'TransactionReversal' });
    expect(String(calls[0].body.ResultURL)).toMatch(/\/cb\/sekret\/reversal$/);
    expect(String(calls[0].body.QueueTimeOutURL)).toMatch(/\/cb\/sekret\/reversal\/timeout$/);

    const before = await rowOf(r.body.id);
    expect(before.type).toBe('reversal');
    expect(before.recipient_kind).toBe('receipt');
    expect(before.recipient_value).toBe(settled.receipt);
    expect(Number(before.amount_cents)).toBe(100);
    expect(before.payload_json.reversalOfRequestId).toBe(settled.id);
    expect((await deps.db.query(`SELECT 1 FROM audit_log WHERE action='reversal.requested' AND target=$1`, [r.body.id])).length).toBe(1);

    await fake.settle();
    const after = await rowOf(r.body.id);
    expect(after.status).toBe('completed');
    expect(after.result_source).toBe('callback');
    expect(after.receipt).toBe(settled.receipt);
    // The money went back to the Utility account: the send reported 34391 shillings, the reversal 34392.
    expect(Number((await latestBalance()).utility_cents)).toBe(3439200);
  });

  it('rule 2: refuses a receipt that never settled, before any call to Safaricom', async () => {
    const r = await reverse('RI00000000');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_settled');
    expect(r.body.error.message).toBe(NOT_SETTLED);
    const f = await findPayment('RI00000000');
    expect(f.status).toBe(409);
    expect(reversalCalls()).toHaveLength(0);
    expect(await reversalRows()).toHaveLength(0);

    // A receipt that exists but has not settled yet is refused for the same reason.
    await deps.db.query(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, receipt)
       VALUES ('b2c','BusinessPayment','oc-pending','sent',100,'phone','254700123456','RI00000009')`);
    const p = await reverse('RI00000009');
    expect(p.status).toBe(409);
    expect(p.body.error.code).toBe('not_settled');
    expect(reversalCalls()).toHaveLength(0);
  });

  it('rule 3: two simultaneous reversals of one receipt produce exactly one request', async () => {
    const settled = await settledSend(100);
    const [owner] = await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE username='owner'`);
    // Widen the window between reading the settled payment and taking the lock, the same way the
    // send path's own concurrency test does: without it two same-tick calls stay in lockstep and
    // would pass even against genuinely racy code.
    const slow: DarajaFactory = {
      ...deps.daraja,
      getForOperator: async (id?: string) => { await new Promise((r) => setTimeout(r, 40)); return deps.daraja.getForOperator(id); },
    };
    const svc = createReversalService({ ...deps, daraja: slow });
    const actor = { personId: owner.id, ip: '1.1.1.1' };
    const [r1, r2] = await Promise.allSettled([
      svc.request({ receipt: settled.receipt }, actor),
      svc.request({ receipt: settled.receipt }, actor),
    ]);
    const ok = [r1, r2].filter((r) => r.status === 'fulfilled');
    const bad = [r1, r2].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toMatchObject({ status: 409, code: 'already_reversed' });
    expect(await reversalRows()).toHaveLength(1);
    expect(reversalCalls()).toHaveLength(1);

    // And pressing it again afterwards is refused too, in the same words.
    const again = await reverse(settled.receipt);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_reversed');
    expect(again.body.error.message).toBe(ALREADY_REVERSED);
  });

  it('rule 3: a reversal waits on the same advisory lock the send path uses, keyed on the receipt', async () => {
    const settled = await settledSend(100);
    const [owner] = await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE username='owner'`);
    const key = KINDS.reversal!.dupKey({ type: 'reversal', recipient_value: settled.receipt, amount_cents: '100', payload_json: {} });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = deps.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      await held;
    });
    await new Promise((r) => setTimeout(r, 100)); // the holder takes the lock first

    // With the lock held, the reversal cannot pass its own guard: nothing is inserted and
    // Safaricom is never called. Without the lock it would sail straight through.
    const svc = createReversalService(deps);
    let outcome: 'pending' | 'done' = 'pending';
    const attempt = svc.request({ receipt: settled.receipt }, { personId: owner.id, ip: '1.1.1.1' }).then(() => { outcome = 'done'; }, () => { outcome = 'done'; });
    await new Promise((r) => setTimeout(r, 250));
    expect(outcome).toBe('pending');
    expect(await reversalRows()).toHaveLength(0);
    expect(reversalCalls()).toHaveLength(0);

    release();
    await holder;
    await attempt;
    expect(outcome).toBe('done');
    expect((await reversalRows())[0]!.status).toBe('sent');
    expect(reversalCalls()).toHaveLength(1);
    await fake.settle();
  });

  it('rule 4a: a refusal from Safaricom shows its own words', async () => {
    const settled = await settledSend(100);
    fake.rejectsSync('2001', 'The initiator information is invalid.');
    const r = await reverse(settled.receipt);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('failed');
    expect(r.body.safaricomSaid).toBe('The initiator information is invalid.');
    expect(r.body.meaning).toBeTruthy();
    expect(r.body.whatToDo).toBeTruthy();
    expect((await deps.db.query<{ status: string }>('SELECT status FROM operators'))[0].status).toBe('failed');
  });

  it('rule 4b: a refusal that says the customer already spent the money explains itself honestly', async () => {
    const settled = await settledSend(100);
    fake.neverAnswers();
    const r = await reverse(settled.receipt);
    expect(r.body.status).toBe('sent');
    const oc = (await rowOf(r.body.id)).payload_json.ackOriginatorConversationId!;

    const cb = await request(app).post('/cb/sekret/reversal').set('X-Forwarded-For', SAF_IP).send({ Result: {
      ResultType: 0, ResultCode: 1, ResultDesc: 'The recipient has already spent the funds.',
      OriginatorConversationID: oc, ConversationID: 'AG_REV',
    } });
    expect(cb.status).toBe(200);
    const v = await request(app).get('/api/requests/' + r.body.id).set('Cookie', cookie);
    expect(v.body.status).toBe('failed');
    expect(v.body.safaricomSaid).toBe('The recipient has already spent the funds.');
    // What the SDK's classifier decided, not "Safaricom did not explain this code".
    expect(v.body.meaning).toBe(SPENT_MEANING);
  });

  it('rule 5: a queue timeout lands unknown, and the sweep resolves it', async () => {
    const settled = await settledSend(100);
    fake.neverAnswers();
    const r = await reverse(settled.receipt);
    expect(r.body.status).toBe('sent');
    const oc = (await rowOf(r.body.id)).payload_json.ackOriginatorConversationId!;

    const t = await request(app).post('/cb/sekret/reversal/timeout').set('X-Forwarded-For', SAF_IP).send({ Result: {
      ResultType: 1, ResultCode: 1, ResultDesc: 'The service request has timed out.',
      OriginatorConversationID: oc, ConversationID: 'AG_REV',
    } });
    expect(t.status).toBe(200);
    const unknown = await rowOf(r.body.id);
    expect(unknown.status).toBe('unknown');
    expect(unknown.meaning).toBe(REVERSAL_QUEUE_TIMEOUT);
    expect(unknown.result_at).toBeNull();
    expect(unknown.result_code).toBeNull();
    expect(unknown.result_source).toBeNull();

    // Safaricom starts answering again, and the sweep finds the row where it left it.
    fake.completes();
    await deps.db.query(`UPDATE requests SET sent_at = now() - interval '3 minutes' WHERE id=$1`, [r.body.id]);
    expect((await deps.moneyOut.sweep()).polled).toBe(1);
    expect(fake.calls.find((c) => c.path.endsWith('/transactionstatus/v1/query'))!.body.OriginatorConversationID).toBe(oc);
    await fake.settle();
    const done = await rowOf(r.body.id);
    expect(done.status).toBe('completed');
    expect(done.result_source).toBe('poll');
    expect(done.receipt).toBe(settled.receipt);
  });

  it('rule 6: the kind is registered where money out is counted', () => {
    const k = KINDS.reversal!;
    expect(k.permission).toBe('reverse.request');
    expect(k.callbackPath).toBe('reversal');
    expect(k.recipient).toBe('receipt');
    expect(k.scope).toBe('reversal');
    // In KINDS means the sweep polls it and the plan's send allowance counts it. Money coming in
    // must never appear there, which is why the collect kinds live in their own map.
    expect(MONEY_TYPES).toContain('reversal');
  });

  it('rule 7: a failed attempt does not burn the receipt, because nothing was reversed', async () => {
    const settled = await settledSend(100);
    fake.rejectsSync('500.001.1001', 'Service unavailable');
    const first = await reverse(settled.receipt);
    expect(first.body.status).toBe('failed');
    const second = await reverse(settled.receipt);
    expect(second.status).toBe(201);
    expect(second.body.status).toBe('sent');
    expect(await reversalRows()).toHaveLength(2);
  });
});
