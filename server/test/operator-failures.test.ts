import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createOperatorService } from '../src/operators/service.js';
import { createEventHub } from '../src/events/hub.js';
import { testDeps, resetTables } from './helpers.js';
import { failOperatorOnCredentialCode } from '../src/money_out/operatorHealth.js';
import { CREDENTIAL_CODES } from '../src/money_out/registry.js';
import { explain } from '../src/sdk/meaning.js';
import { applyResult } from '../src/callbacks/apply.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Feature 8. One credential refusal is often a stale password that the next call with a fresh token
 * survives, so an operator goes DOWN on the second refusal inside ten minutes, never the first.
 * The rule lives in money_out/operatorHealth.ts; these tests pin it at all three call sites.
 */
const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(async () => { await deps.db.end(); });

const fakeFactory = (query: () => Promise<unknown>): DarajaFactory => ({
  get: async () => ({ balance: { query } }) as never,
  getForOperator: async () => ({ balance: { query } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
});

/** A verified operator carrying whatever guard state a test needs; the real one gets it from probes and results. */
async function seedOperator(over: { status?: string; failures?: number; lastFailureAt?: string | null; downSince?: string | null } = {}): Promise<string> {
  const [row] = await deps.db.query<{ id: string }>(
    `INSERT INTO operators(name, credential_enc, status, verified_at, consecutive_failures, last_failure_at, down_since)
     VALUES ('APIONE', $1, $2, now(), $3, $4::timestamptz, $5::timestamptz) RETURNING id`,
    [encrypt(deps.config.secretKey, 'c'), over.status ?? 'verified', over.failures ?? 0, over.lastFailureAt ?? null, over.downSince ?? null],
  );
  return row.id;
}

async function operatorRow(id: string) {
  const [row] = await deps.db.query<{ status: string; consecutive_failures: number; last_failure_at: Date | null; down_since: Date | null; last_error: string | null }>(
    'SELECT status, consecutive_failures, last_failure_at, down_since, last_error FROM operators WHERE id=$1', [id]);
  return row;
}

/** Safaricom's own b2c result envelope, the shape the real callback carries. */
const b2cBody = (oc: string, code = 0) => ({
  Result: {
    ResultType: 0, ResultCode: code,
    ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'The initiator information is invalid.',
    OriginatorConversationID: oc, ConversationID: `AG_${oc}`, TransactionID: code === 0 ? 'RI6BZTPXNM' : '',
    ...(code === 0 ? { ResultParameters: { ResultParameter: [
      { Key: 'B2CUtilityAccountAvailableFunds', Value: 34391 },
      { Key: 'B2CWorkingAccountAvailableFunds', Value: 14 },
    ] } } : {}),
  },
});

async function seedSend(oc: string, operatorId: string): Promise<void> {
  await deps.db.query(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, operator_id, sent_at)
     VALUES ('b2c','BusinessPayment',$1,'sent',100,'phone','254700123456',$2,now())`,
    [oc, operatorId]);
}

beforeEach(async () => { await resetTables(deps.db); });

describe('the two-try guard', () => {
  it('one credential failure records itself and leaves the operator working', async () => {
    const id = await seedOperator();

    expect(await failOperatorOnCredentialCode(deps.db, events, id, 2001, 'The initiator information is invalid.')).toBe(true);

    const op = await operatorRow(id);
    expect(op.status).toBe('verified');
    expect(op.consecutive_failures).toBe(1);
    expect(op.last_failure_at).not.toBeNull();
    expect(op.down_since).toBeNull();
    expect(op.last_error).toMatch(/initiator information/);
  });

  it('a second failure inside ten minutes takes the operator DOWN, with one event', async () => {
    const id = await seedOperator({ failures: 1, lastFailureAt: new Date().toISOString() });
    const statuses: string[] = [];
    const unsub = events.subscribe((e) => { if (e.type === 'operator.updated') statuses.push(String((e.payload as { status?: string }).status)); });
    await events.start();
    try {
      await failOperatorOnCredentialCode(deps.db, events, id, 2001, 'The initiator information is invalid.');
      await new Promise((r) => setTimeout(r, 200));
    } finally { unsub(); await events.stop(); }

    const op = await operatorRow(id);
    expect(op.status).toBe('failed');
    expect(op.consecutive_failures).toBe(2);
    expect(op.down_since).not.toBeNull();
    expect(statuses).toEqual(['failed']);
  });

  it('a failure after the window starts the count again instead of going DOWN', async () => {
    const id = await seedOperator({ failures: 1, lastFailureAt: new Date(Date.now() - 11 * 60_000).toISOString() });

    await failOperatorOnCredentialCode(deps.db, events, id, 2001, 'The initiator information is invalid.');

    const op = await operatorRow(id);
    expect(op.status).toBe('verified');
    expect(op.consecutive_failures).toBe(1);
    expect(op.down_since).toBeNull();
  });

  it('a code that is not a credential failure leaves the count and the error alone', async () => {
    const id = await seedOperator({ failures: 1, lastFailureAt: new Date().toISOString() });

    expect(await failOperatorOnCredentialCode(deps.db, events, id, 1032, 'The customer cancelled the prompt.')).toBe(false);

    const op = await operatorRow(id);
    expect(op.consecutive_failures).toBe(1);
    expect(op.last_error).toBeNull();
  });

  it('a disabled operator is never touched', async () => {
    const id = await seedOperator({ status: 'disabled' });

    expect(await failOperatorOnCredentialCode(deps.db, events, id, 2001, 'The initiator information is invalid.')).toBe(false);

    const op = await operatorRow(id);
    expect(op.status).toBe('disabled');
    expect(op.consecutive_failures).toBe(0);
    expect(op.last_error).toBeNull();
  });
});

describe('what clears the guard', () => {
  it('a probe Safaricom accepts clears the count and the DOWN clock', async () => {
    const id = await seedOperator({ status: 'failed', failures: 2, lastFailureAt: new Date().toISOString(), downSince: new Date().toISOString() });
    await deps.settings.set('public.url', 'https://studio.example');
    const query = vi.fn(async () => ({ originatorConversationId: 'OC-CLEAR', conversationId: 'AG-OC-CLEAR', responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query), events });

    await svc.probe(id);

    expect(query).toHaveBeenCalled();
    const op = await operatorRow(id);
    expect(op.consecutive_failures).toBe(0);
    expect(op.last_failure_at).toBeNull();
    expect(op.down_since).toBeNull();
    expect(op.status).toBe('pending');
  });

  it('a request of that operator settling successfully clears them too', async () => {
    const id = await seedOperator({ status: 'failed', failures: 2, lastFailureAt: new Date().toISOString(), downSince: new Date().toISOString() });
    await seedSend('OC-SETTLED', id);

    const verdict = await applyResult({ db: deps.db, events }, 'b2c', b2cBody('OC-SETTLED'));

    expect(verdict.verdict).toBe('applied');
    const op = await operatorRow(id);
    expect(op.consecutive_failures).toBe(0);
    expect(op.last_failure_at).toBeNull();
    expect(op.down_since).toBeNull();
  });

  it('a credential refusal on that operator\'s own row counts one failure, not a DOWN on the first', async () => {
    const id = await seedOperator();
    await seedSend('OC-REFUSED', id);

    const verdict = await applyResult({ db: deps.db, events }, 'b2c', b2cBody('OC-REFUSED', 2001));

    expect(verdict.verdict).toBe('applied');
    const op = await operatorRow(id);
    expect(op.status).toBe('verified');
    expect(op.consecutive_failures).toBe(1);
    expect(op.last_error).toMatch(/initiator information/);
  });
});

describe('TP40153, the other credential code', () => {
  it('counts as a credential failure and takes the operator DOWN on the second one', async () => {
    expect(CREDENTIAL_CODES.has('TP40153')).toBe(true);
    const id = await seedOperator({ failures: 1, lastFailureAt: new Date().toISOString() });

    await failOperatorOnCredentialCode(deps.db, events, id, 'TP40153', 'The initiator information is invalid.');

    const op = await operatorRow(id);
    expect(op.status).toBe('failed');
    expect(op.consecutive_failures).toBe(2);
  });

  it('its three lines name the operator credential, not the payment, on every scope that can see it', () => {
    const ex = explain('b2c', 'TP40153', 'The initiator information is invalid.');
    expect(ex.safaricomSaid).toBe('The initiator information is invalid.');
    expect(ex.meaning).toMatch(/operator/i);
    expect(ex.meaning).toMatch(/did not fail/i);
    expect(ex.whatToDo).toMatch(/Reinstate/);
    for (const scope of ['b2c', 'b2b', 'balance', 'reversal'] as const) {
      const e = explain(scope, 'TP40153', 'The initiator information is invalid.');
      expect(e.meaning).not.toMatch(/did not explain this code/);
      expect(e.whatToDo).toMatch(/Reinstate/);
    }
  });
});
