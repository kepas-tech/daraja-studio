import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, resetTables, loginAsOwner, TEST_ORG_ID } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { buildHandlers } from '../src/scheduler/handlers.js';
import { createScheduler } from '../src/scheduler/loop.js';
import { BALANCE_REFRESH_DELAY_MS } from '../src/money_out/balanceRefresh.js';

const SAF_IP = '196.201.214.200';

const balanceQuery = vi.fn(async () => ({
  conversationId: 'AG_B',
  originatorConversationId: `bal-${Math.random().toString(36).slice(2)}`,
  responseCode: '0', responseDescription: 'ok',
}));
const daraja: DarajaFactory = {
  get: async () => ({}) as never,
  getForOperator: async () => ({ balance: { query: balanceQuery }, config: { initiator: 'APIONE' } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
};
const { app, deps, close } = makeApp({ daraja });
afterAll(close);

function b2cBody(oc: string, code = 0) {
  const ok = code === 0;
  return { Result: {
    ResultType: 0, ResultCode: code, ResultDesc: ok ? 'The service request is processed successfully.' : 'The initiator information is invalid.',
    OriginatorConversationID: oc, ConversationID: `AG_${oc}`, TransactionID: ok ? 'RI6BZTPXNM' : '',
    ...(ok ? { ResultParameters: { ResultParameter: [
      { Key: 'TransactionAmount', Value: 1 }, { Key: 'TransactionReceipt', Value: 'RI6BZTPXNM' },
      { Key: 'ReceiverPartyPublicName', Value: '254700123456 - Jane Doe' },
      { Key: 'B2CUtilityAccountAvailableFunds', Value: 34391 }, { Key: 'B2CWorkingAccountAvailableFunds', Value: 14 },
    ] } } : {}),
    ReferenceData: { ReferenceItem: { Key: 'QueueTimeoutURL', Value: 'https://studio.example/cb/sekret/b2c' } },
  } };
}
const timeoutBody = (oc: string) => ({ Result: { ResultType: 1, ResultCode: 1, ResultDesc: 'The service request has timed out.', OriginatorConversationID: oc, ConversationID: `AG_${oc}` } });
const balanceResultBody = (oc: string) => ({ Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
  OriginatorConversationID: oc, ConversationID: 'AG_B', TransactionID: 'X',
  ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Working Account|KES|14.00|14.00|0.00|0.00&Utility Account|KES|34392.00|34392.00|0.00|0.00&Charges Paid Account|KES|0.00|0.00|0.00|0.00' }] } } });

async function seedOperator(name = 'APIONE') {
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ($1, $2, 'verified')`, [name, encrypt(deps.config.secretKey, 'c')]);
}
async function seedB2c(oc: string, status = 'sent', opId: string | null = null) {
  const [op] = opId ? [{ id: opId }] : await deps.db.query<{ id: string }>(`SELECT id FROM operators WHERE name='APIONE'`);
  const [row] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, operator_id, sent_at)
     VALUES ('b2c','BusinessPayment',$1,$2,100,'phone','254700123456',$3,now()) RETURNING id`, [oc, status, op.id]);
  return row.id;
}
const settle = (oc: string, code = 0) => request(app).post('/cb/sekret/b2c').set('X-Forwarded-For', SAF_IP).send(b2cBody(oc, code));
const pendingRefreshes = () => deps.db.query<{ run_at: Date; max_attempts: number; payload: { reason?: string; orgId?: string } }>(
  `SELECT run_at, max_attempts, payload FROM jobs WHERE kind='balance_refresh' AND done_at IS NULL`);

describe('a settled request refreshes the balance, once a minute', () => {
  beforeEach(async () => { await resetTables(deps.db); balanceQuery.mockClear(); });

  it('a completed result enqueues exactly one refresh, due about a minute out', async () => {
    await seedOperator();
    await seedB2c('OC1');
    const r = await settle('OC1');
    expect(r.status).toBe(200);
    const jobs = await pendingRefreshes();
    expect(jobs).toHaveLength(1);
    const dueIn = jobs[0].run_at.getTime() - Date.now();
    expect(dueIn).toBeGreaterThan(BALANCE_REFRESH_DELAY_MS - 15_000);
    expect(dueIn).toBeLessThan(BALANCE_REFRESH_DELAY_MS + 15_000);
    expect(jobs[0].max_attempts).toBe(2);
    expect(jobs[0].payload).toMatchObject({ reason: 'settled', orgId: TEST_ORG_ID });
  });

  it('a second settled request while that refresh waits enqueues nothing more', async () => {
    await seedOperator();
    await seedB2c('OC2');
    await settle('OC2');
    await seedB2c('OC3');
    await settle('OC3');
    expect(await pendingRefreshes()).toHaveLength(1);
  });

  it('a failed result settles too, and a row that has not settled does not', async () => {
    await seedOperator();
    await seedB2c('OC4');
    await settle('OC4', 2001);
    const [failed] = await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC4'`);
    expect(failed.status).toBe('failed');
    expect(await pendingRefreshes()).toHaveLength(1);
    // A row still in flight: seeded, no result, then Safaricom's queue timeout, which leaves it
    // "unknown" — the sweep may still settle it, so nothing refreshes yet.
    await seedB2c('OC5');
    expect(await pendingRefreshes()).toHaveLength(1);
    await request(app).post('/cb/sekret/b2c/timeout').set('X-Forwarded-For', SAF_IP).send(timeoutBody('OC5'));
    const [unknown] = await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC5'`);
    expect(unknown.status).toBe('unknown');
    expect(await pendingRefreshes()).toHaveLength(1);
  });

  it('two results landing together still leave one refresh', async () => {
    await seedOperator();
    await seedB2c('OC6');
    await seedB2c('OC7');
    const [a, b] = await Promise.all([settle('OC6'), settle('OC7')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await pendingRefreshes()).toHaveLength(1);
  });

  it('the refresh job reads the balance once, and the answer writes one more snapshot', async () => {
    await seedOperator();
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await seedB2c('OC8');
    await settle('OC8');
    const before = (await deps.db.query('SELECT 1 FROM balances')).length;
    await deps.db.query(`UPDATE jobs SET run_at=now() WHERE kind='balance_refresh'`);

    const handlers = buildHandlers({
      db: deps.db, events: deps.events, settings: deps.settings, moneyOut: deps.moneyOut,
      operators: deps.operators, moneyIn: deps.moneyIn, bulk: deps.bulk,
    });
    const scheduler = createScheduler(deps.db, handlers, { workerId: 'balance-refresh-test' });
    expect(await scheduler.tick()).toBe(1);
    expect(balanceQuery).toHaveBeenCalledTimes(1);
    expect((await deps.db.query(`SELECT 1 FROM jobs WHERE kind='balance_refresh' AND done_at IS NULL`))).toHaveLength(0);

    const [asked] = await deps.db.query<{ originator_conversation_id: string; status: string }>(
      `SELECT originator_conversation_id, status FROM requests WHERE type='balance' AND subtype='refresh'`);
    expect(asked.status).toBe('sent');
    const answer = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceResultBody(asked.originator_conversation_id));
    expect(answer.status).toBe(200);
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(before + 1);
  });

  it('latest carries what is waiting to go out, and only what has not finished', async () => {
    const { cookie } = await loginAsOwner(app, deps);
    await deps.db.query(`INSERT INTO balances(working_cents, utility_cents, charges_paid_cents, raw) VALUES (1400, 3439100, 0, '{}')`);
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status, amount_cents) VALUES
      ('b2c','W1','pending',100),
      ('b2c','W2','sent',250),
      ('b2c','W3','awaiting_approval',400),
      ('reversal','W4','sent',50),
      ('b2c','W5','failed',999),
      ('b2c','W6','completed',999),
      ('c2b','W7','completed',5000)`);
    const r = await request(app).get('/api/balances/latest').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.waitingCents).toBe(800);
    expect(r.body.utilityCents).toBe(3439100);
    expect(typeof r.body.queriedAt).toBe('string');
  });
});
