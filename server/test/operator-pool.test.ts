import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createEventHub } from '../src/events/hub.js';
import { createMoneyOutService } from '../src/money_out/service.js';
import { createNotificationsService } from '../src/notifications/service.js';
import { createNotificationWriter } from '../src/notifications/writer.js';
import { applyResult } from '../src/callbacks/apply.js';
import { recordOperatorRefusal } from '../src/money_out/operatorHealth.js';
import { testDeps, resetTables } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import { HttpError } from '../src/util/errors.js';
import { DarajaAPIError } from '@kepas/daraja-js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Brief 2, item 7: the rest of KEPAS Pay's operator pool. One request in flight per operator, the
 * same row sent again with the next verified operator after a credential-class refusal (on the send
 * path and from the result callback), and one critical line when nothing verified is left.
 */
const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(async () => { await deps.db.end(); });

const ACTOR = { personId: '', ip: '1.1.1.1' };
const SEND = { phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' as const };

const ack = (input: { originatorConversationId: string }) => ({ conversationId: 'AG_POOL', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' });
/** A refusal the way the SDK raises one: Safaricom's own code and text. */
const refused = (code: number, desc: string) => new DarajaAPIError(desc, { resultCode: code, resultDesc: desc, scope: 'b2c' });

/** The pool as the real factory picks it: verified only, priority order, minus the excluded. */
function factory(sendFor: (name: string, input: { originatorConversationId: string }) => Promise<unknown>): DarajaFactory {
  return {
    get: async () => ({}) as never,
    getForOperator: async (_id?: string, opts?: { exclude?: string[] }) => {
      const [row] = await deps.db.query<{ name: string }>(
        `SELECT name FROM operators WHERE status='verified' AND id <> ALL($1::uuid[]) ORDER BY priority ASC, created_at ASC LIMIT 1`,
        [opts?.exclude ?? []]);
      if (!row) throw new HttpError(409, 'no_operator', 'Add or fix an API operator in Settings first.');
      return { config: { initiator: row.name }, b2c: { send: (input: { originatorConversationId: string }) => sendFor(row.name, input) } } as never;
    },
    invalidate: () => {},
    stkEnabled: async () => false,
  } as unknown as DarajaFactory;
}

const service = (sendFor: Parameters<typeof factory>[0]) => createMoneyOutService({ ...deps, daraja: factory(sendFor), events });

/** Safaricom's own b2c result envelope, the shape a real callback carries. */
const b2cBody = (oc: string, code = 0) => ({
  Result: {
    ResultType: 0, ResultCode: code,
    ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'The initiator information is invalid.',
    OriginatorConversationID: oc, ConversationID: `AG_${oc}`, TransactionID: code === 0 ? 'RI6BZTPXNM' : '',
  },
});

let aId = '';
let bId = '';

async function seedOperators(): Promise<void> {
  const [a] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1) RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
  const [b] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APITWO',$1,'verified',2) RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
  aId = a.id; bId = b.id;
}

async function rows() {
  return deps.db.query<{ id: string; status: string; operator_id: string | null; result_code: string | null }>(
    `SELECT id, status, operator_id, result_code FROM requests WHERE type='b2c' ORDER BY created_at`, []);
}

beforeEach(async () => {
  await resetTables(deps.db);
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
  ACTOR.personId = p.id;
  await seedOperators();
});

describe('one request in flight per operator', () => {
  it('makes two sends take the slot in turn, never two at once', async () => {
    let inFlight = 0; let most = 0;
    const send = vi.fn(async (_name: string, input: { originatorConversationId: string }) => {
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight -= 1;
      return ack(input);
    });
    const svc = service(send);
    const [first, second] = await Promise.all([
      svc.send({ ...SEND, phone: '0700123456' }, ACTOR),
      svc.send({ ...SEND, phone: '0700123457' }, ACTOR),
    ]);
    expect(most).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect([first.status, second.status]).toEqual(['sent', 'sent']);
  });
});

describe('failover after a credential-class refusal', () => {
  it('sends the same row again with the next verified operator', async () => {
    const send = vi.fn(async (name: string, input: { originatorConversationId: string }) => {
      if (name === 'APIONE') throw refused(2001, 'The initiator information is invalid.');
      return ack(input);
    });
    const v = await service(send).send(SEND, ACTOR);

    expect(v.status).toBe('sent');
    expect(send.mock.calls.map((c) => c[0])).toEqual(['APIONE', 'APITWO']);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(v.id);
    expect(all[0].operator_id).toBe(bId);
    expect(all[0].result_code).toBeNull();
  });

  it('does the same from the result callback, on the row that result belongs to', async () => {
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, operator_id, sent_at)
       VALUES ('b2c','BusinessPayment','OC-POOL-1','sent',100,'phone','254700123456',$1,now()) RETURNING id`, [aId]);
    const send = vi.fn(async (_name: string, input: { originatorConversationId: string }) => ack(input));
    const svc = service(send);

    const verdict = await applyResult({ db: deps.db, events, failover: (id, operatorId) => svc.failover(id, operatorId) }, 'b2c', b2cBody('OC-POOL-1', 2001));

    expect(verdict.verdict).toBe('applied');
    expect(send.mock.calls.map((c) => c[0])).toEqual(['APITWO']);
    const [after] = await deps.db.query<{ id: string; status: string; operator_id: string }>('SELECT id, status, operator_id FROM requests WHERE id=$1', [row.id]);
    expect(after.id).toBe(row.id);
    expect(after.status).toBe('sent');
    expect(after.operator_id).toBe(bId);
  });

  it('fails the row as before when no other operator is attached', async () => {
    await deps.db.query(`DELETE FROM operators WHERE name='APITWO'`);
    const send = vi.fn(async () => { throw refused(2001, 'The initiator information is invalid.'); });
    const v = await service(send).send(SEND, ACTOR);

    expect(v.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    const all = await rows();
    expect(all[0].result_code).toBe('2001');
  });

  it('never fails over on a failure that is not about the credential', async () => {
    const send = vi.fn(async () => { throw refused(1032, 'The customer cancelled the prompt.'); });
    const v = await service(send).send(SEND, ACTOR);

    expect(v.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    const [a] = await deps.db.query<{ status: string; consecutive_failures: number }>(`SELECT status, consecutive_failures FROM operators WHERE id=$1`, [aId]);
    expect(a).toMatchObject({ status: 'verified', consecutive_failures: 0 });
  });
});

describe('when nothing is left', () => {
  it('writes one critical line, once, for the whole outage', async () => {
    const notifications = createNotificationsService({ db: deps.db, events });
    const writer = createNotificationWriter({ db: deps.db, events, notifications });
    writer.start();
    await events.start();
    try {
      // The second refusal is the one that takes the last operator down.
      await deps.db.query(`UPDATE operators SET consecutive_failures=1, last_failure_at=now() WHERE id=$1`, [aId]);
      await deps.db.query(`DELETE FROM operators WHERE name='APITWO'`);
      const send = vi.fn(async () => { throw refused(2001, 'The initiator information is invalid.'); });
      const v = await service(send).send(SEND, ACTOR);
      expect(v.status).toBe('failed');

      const found = await waitFor(async () => {
        const r = await deps.db.query<{ severity: string; category: string; title: string; body: string; count: number; data: Record<string, unknown> }>(
          `SELECT severity, category, title, body, count, data FROM notifications WHERE type='operators.exhausted'`);
        return r.length > 0 ? r : null;
      });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ severity: 'critical', category: 'operators', title: 'No working operator left', body: 'Payments out cannot go until you fix one.', count: 1 });
      expect(found[0].data.href).toBe('/account');

      // A second refusal in the same outage bumps the count, not the inbox.
      await recordOperatorRefusal(deps.db, events, aId, '2001', 'again');
      await waitFor(async () => {
        const r = await deps.db.query<{ count: number }>(`SELECT count FROM notifications WHERE type='operators.exhausted'`);
        return r[0]?.count === 2 ? r : null;
      });
      const after = await deps.db.query<{ count: number }>(`SELECT count FROM notifications WHERE type='operators.exhausted'`);
      expect(after).toHaveLength(1);
    } finally {
      writer.stop();
      await events.stop();
    }
  });
});

/** Poll until an assertion's subject exists: the hub delivers over LISTEN/NOTIFY, so it is a beat behind. */
async function waitFor<T>(fn: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('nothing arrived in time');
}
