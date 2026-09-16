import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createEventHub } from '../src/events/hub.js';
import { createMoneyOutService, isV3GatewayRefusal } from '../src/money_out/service.js';
import { UNKNOWN_WHAT_TO_DO } from '../src/money_out/reads.js';
import { testDeps, resetTables } from './helpers.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { HttpError } from '../src/util/errors.js';
import { DarajaAPIError, DarajaAuthError, DarajaConnectionError } from '@kepas/daraja-js';
import { encrypt } from '../src/crypto/secrets.js';

const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(() => deps.db.end());

const ACTOR = { personId: '', ip: '1.1.1.1' };
const RECIPIENT = '254700123456';

function factory(send: (input: unknown) => Promise<unknown>, _opId: string): DarajaFactory {
  return {
    get: async () => ({ b2c: { send } }) as never,
    getForOperator: async () => ({ b2c: { send }, config: { initiator: 'APIONE' } }) as never,
    invalidate: () => {},
    stkEnabled: async () => false,
  } as unknown as DarajaFactory & { opId: string };
}
const ack = vi.fn(async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_1', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));

describe('money out: send', () => {
  let opId: string;
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
    ACTOR.personId = p.id;
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1) RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    opId = op.id;
    ack.mockClear();
  });

  it('inserts a pending row before the SDK call, then marks it sent with the ack', async () => {
    let statusAtSendTime = '';
    const send = vi.fn(async (input: { originatorConversationId: string }) => {
      const [r] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE originator_conversation_id=$1', [input.originatorConversationId]);
      statusAtSendTime = r.status;
      return ack(input);
    });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment', remarks: 'test' }, ACTOR);
    expect(statusAtSendTime).toBe('pending');
    expect(v.status).toBe('sent');
    expect(v.amountCents).toBe(100);
    expect(v.recipient.value).toBe(RECIPIENT);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ phone: RECIPIENT, amount: 1, commandId: 'BusinessPayment', originatorConversationId: expect.any(String), resultUrl: 'https://studio.example/cb/sekret/b2c', queueTimeoutUrl: 'https://studio.example/cb/sekret/b2c/timeout' }));
    const [row] = await deps.db.query<{ status: string; conversation_id: string; operator_id: string; sent_at: Date; subtype: string; created_by: string; payload_json: Record<string, unknown> }>('SELECT status, conversation_id, operator_id, sent_at, subtype, created_by, payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row.conversation_id).toBe('AG_1');
    expect(row.operator_id).toBe(opId);
    expect(row.subtype).toBe('BusinessPayment');
    expect(row.created_by).toBe(ACTOR.personId);
    // The ack echoed our own OriginatorConversationID back, so nothing extra is kept.
    expect(row.payload_json.ackOriginatorConversationId).toBeUndefined();
    // audit_log isn't truncated between tests (see helpers.resetTables), so filter by this
    // request's own id rather than assuming this is the only 'request.created' row (see the
    // same note in operators.test.ts).
    const audit = await deps.db.query<{ action: string; target: string }>(`SELECT action, target FROM audit_log WHERE action='request.created' AND target=$1`, [v.id]);
    expect(audit[0].target).toBe(v.id);
  });

  it('keeps the ack\'s own OriginatorConversationID when Safaricom returns one different from ours', async () => {
    const send = vi.fn(async () => ({ conversationId: 'AG_2', originatorConversationId: 'SAF-OC-1', responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('sent');
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row.payload_json.ackOriginatorConversationId).toBe('SAF-OC-1');
  });

  it('rejects cents, a bad phone, and an amount above the cap', async () => {
    const svc = createMoneyOutService({ ...deps, config: { ...deps.config, maxSendCents: 100 }, daraja: factory(ack, opId), events });
    await expect(svc.send({ phone: '0700123456', amountCents: 150, commandId: 'BusinessPayment' }, ACTOR)).rejects.toMatchObject({ status: 400, code: 'whole_shillings' });
    await expect(svc.send({ phone: '12345', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR)).rejects.toMatchObject({ status: 400, code: 'bad_phone' });
    await expect(svc.send({ phone: '0700123456', amountCents: 200, commandId: 'BusinessPayment' }, ACTOR)).rejects.toMatchObject({ status: 409, code: 'over_cap' });
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
  });

  it('duplicate guard: same recipient and amount within 5 minutes needs confirmDuplicate', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack, opId), events });
    const first = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    await expect(svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR)).rejects.toMatchObject({ status: 409, code: 'duplicate_recent', details: expect.objectContaining({ requestId: first.id }) });
    const second = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment', confirmDuplicate: true }, ACTOR);
    expect(second.id).not.toBe(first.id);
    // A failed earlier request does not count as a duplicate.
    await deps.db.query(`UPDATE requests SET status='failed', result_source=NULL WHERE id=$1`, [second.id]);
    await deps.db.query(`UPDATE requests SET status='failed' WHERE id=$1`, [first.id]);
    await expect(svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR)).resolves.toBeTruthy();
  });

  it('W3: two concurrent identical sends are serialised by an advisory lock — exactly one succeeds, the other sees the duplicate', async () => {
    // A slow operator lookup between the dup-check and the insert widens the race window enough
    // for two same-tick Promise.all calls to reliably interleave there (without it, both calls'
    // otherwise-identical chain of awaits tends to stay in lockstep and never actually overlap in
    // this harness — which would make the test pass even on the unpatched, genuinely racy code).
    const slowDaraja: DarajaFactory = {
      get: async () => ({ b2c: { send: ack } }) as never,
      getForOperator: async () => { await new Promise((r) => setTimeout(r, 30)); return { b2c: { send: ack }, config: { initiator: 'APIONE' } } as never; },
      invalidate: () => {}, stkEnabled: async () => false,
    };
    const svc = createMoneyOutService({ ...deps, daraja: slowDaraja, events });
    const [r1, r2] = await Promise.allSettled([
      svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR),
      svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR),
    ]);
    const fulfilled = [r1, r2].filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409, code: 'duplicate_recent' });
    expect(await deps.db.query(`SELECT id FROM requests WHERE type='b2c'`)).toHaveLength(1);
  });

  it('a synchronous Safaricom rejection marks the row failed with three lines', async () => {
    // A real sync rejection carries Safaricom's code/text on `raw`, not on resultCode/resultDesc
    // (the SDK's errorFromResponse only sets those when the caller passes them explicitly).
    const send = vi.fn(async () => { throw new DarajaAPIError('The initiator information is invalid.', { scope: 'b2c', raw: { ResponseCode: '2001', ResponseDescription: 'The initiator information is invalid.' } }); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'SalaryPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    expect(v.safaricomSaid).toBe('The initiator information is invalid.');
    expect(v.whatToDo).toMatch(/operator/i);
    const [op] = await deps.db.query<{ status: string; last_error: string }>('SELECT status, last_error FROM operators WHERE id=$1', [opId]);
    expect(op.status).toBe('failed');
    expect(op.last_error).toMatch(/initiator information/);
  });

  it('a synchronous rejection shaped with errorCode/errorMessage still reads Safaricom\'s own text, and does not touch an uncatalogued operator credential code', async () => {
    const send = vi.fn(async () => { throw new DarajaAPIError('Invalid Access Token', { scope: 'b2c', raw: { requestId: 'x', errorCode: '500.001.1001', errorMessage: 'Invalid Access Token' } }); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    expect(v.safaricomSaid).toBe('Invalid Access Token');
    const [row] = await deps.db.query<{ result_code: string }>('SELECT result_code FROM requests WHERE id=$1', [v.id]);
    expect(row.result_code).toBe('500.001.1001');
    const [op] = await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [opId]);
    expect(op.status).toBe('verified');
  });

  it('a connection error after the request may have left marks the row unknown for the sweep, with a third line', async () => {
    const send = vi.fn(async () => { throw new DarajaConnectionError('request timed out after 30000ms'); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('unknown');
    expect(v.meaning).toMatch(/could not confirm/i);
    expect(v.whatToDo).toBe(UNKNOWN_WHAT_TO_DO);
    const [row] = await deps.db.query<{ sent_at: Date | null; operator_id: string }>('SELECT sent_at, operator_id FROM requests WHERE id=$1', [v.id]);
    expect(row.sent_at).not.toBeNull();
    expect(row.operator_id).toBe(opId);
  });

  it('a duplicate-id rejection from Safaricom (the request already left) also marks the row unknown, leaving the operator alone', async () => {
    const send = vi.fn(async () => { throw new DarajaAPIError('Duplicate OriginatorConversationID', { resultCode: 500, resultDesc: 'Duplicate OriginatorConversationID', scope: 'b2c' }); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('unknown');
    const [op] = await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [opId]);
    expect(op.status).toBe('verified');
  });

  it('a 5xx from Daraja may mean the payment already queued, so it is marked unknown rather than failed', async () => {
    const send = vi.fn(async () => { throw Object.assign(new DarajaAPIError('Daraja request failed (HTTP 503)', { scope: 'b2c' }), { httpStatus: 503 }); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('unknown');
    const [op] = await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [opId]);
    expect(op.status).toBe('verified');
  });

  it('an OAuth/credential failure (DarajaAuthError) marks the row failed with a Settings pointer, leaving the operator alone', async () => {
    const send = vi.fn(async () => { throw new DarajaAuthError('OAuth token request failed (HTTP 401)'); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    expect(v.safaricomSaid).toBe('OAuth token request failed (HTTP 401)');
    expect(v.whatToDo).not.toBeNull();
    const [row] = await deps.db.query<{ result_code: string | null; retriable: boolean }>('SELECT result_code, retriable FROM requests WHERE id=$1', [v.id]);
    expect(row.result_code).toBeNull();
    expect(row.retriable).toBe(false);
    const [op] = await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [opId]);
    expect(op.status).toBe('verified');
  });

  it('throws no_operator and writes nothing when the factory has no operator', async () => {
    const f: DarajaFactory = { get: async () => ({}) as never, getForOperator: async () => { throw new HttpError(409, 'no_operator', 'x'); }, invalidate: () => {}, stkEnabled: async () => false };
    const svc = createMoneyOutService({ ...deps, daraja: f, events });
    await expect(svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR)).rejects.toMatchObject({ code: 'no_operator' });
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
  });
});

// env.<env>.b2cApi ('auto' | 'v1' | 'v3', default 'auto') decides whether
// KINDS.b2c.send includes our own OriginatorConversationID (v3) or not (v1). In 'auto', a
// synchronous 403.002.1001 gateway refusal of a v3 attempt is retried once on v1, and the
// resolved version is remembered.
describe('money out: b2c API version (auto detection + v1 fallback)', () => {
  let opId: string;
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
    ACTOR.personId = p.id;
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1) RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    opId = op.id;
  });

  const gatewayRefusal = () => Object.assign(
    new DarajaAPIError('You are not authorized to initiate this transaction.', { raw: { requestId: 'r1', errorCode: '403.002.1001', errorMessage: 'You are not authorized to initiate this transaction.' } }),
    { httpStatus: 403 },
  );

  it('auto (default, no prior detection): sends on v3 and, on success, persists detected=v3', async () => {
    const send = vi.fn(async (input: { originatorConversationId?: string }) => ({ conversationId: 'AG_V3', originatorConversationId: input.originatorConversationId!, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toHaveProperty('originatorConversationId');
    expect(await deps.settings.get('env.sandbox.b2cApiDetected')).toBe('v3');
    expect(await deps.settings.get('env.sandbox.b2cApiDetectedAt')).toBeTruthy();
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row.payload_json.b2cApiUsed).toBe('v3');
  });

  it('explicit v1: never attempts v3, omits originatorConversationId, does not touch detection', async () => {
    await deps.settings.set('env.sandbox.b2cApi', 'v1');
    const send = vi.fn(async () => ({ conversationId: 'AG_V1', originatorConversationId: 'SAF-V1-1', responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).not.toHaveProperty('originatorConversationId');
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row.payload_json.b2cApiUsed).toBe('v1');
    expect(row.payload_json.ackOriginatorConversationId).toBe('SAF-V1-1');
    expect(await deps.settings.get('env.sandbox.b2cApiDetected')).toBeNull();
  });

  it('explicit v3: always includes originatorConversationId', async () => {
    await deps.settings.set('env.sandbox.b2cApi', 'v3');
    const send = vi.fn(async (input: { originatorConversationId?: string }) => ({ conversationId: 'AG_V3', originatorConversationId: input.originatorConversationId!, responseCode: '0', responseDescription: 'x' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('sent');
    expect(send.mock.calls[0][0]).toHaveProperty('originatorConversationId');
  });

  it('auto + a synchronous v3 gateway refusal (403.002.1001): retries the SAME row on v1 within one send() call, completes, detects v1, alerts', async () => {
    let call = 0;
    const send = vi.fn(async () => {
      call++;
      if (call === 1) throw gatewayRefusal();
      return { conversationId: 'AG_V1', originatorConversationId: 'SAF-V1-9', responseCode: '0', responseDescription: 'Accept the service request successfully.' };
    });
    const alerts: unknown[] = [];
    const unsub = events.subscribe((e) => { if (e.type === 'alert') alerts.push(e.payload); });
    await events.start();
    try {
      const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
      const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
      expect(v.status).toBe('sent');
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0][0]).toHaveProperty('originatorConversationId');
      expect(send.mock.calls[1][0]).not.toHaveProperty('originatorConversationId');
      const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
      expect(row.payload_json.b2cApiUsed).toBe('v1');
      expect(row.payload_json.ackOriginatorConversationId).toBe('SAF-V1-9');
      expect(await deps.settings.get('env.sandbox.b2cApiDetected')).toBe('v1');
      expect(await deps.settings.get('env.sandbox.b2cApiDetectedAt')).toBeTruthy();
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContainEqual({ kind: 'b2c_api_detected', version: 'v1' });
    } finally { unsub(); await events.stop(); }
  });

  it('after v1 is detected, the next auto send goes straight to v1 (no v3 attempt)', async () => {
    await deps.settings.set('env.sandbox.b2cApiDetected', 'v1');
    await deps.settings.set('env.sandbox.b2cApiDetectedAt', new Date().toISOString());
    const send = vi.fn(async () => ({ conversationId: 'AG_V1B', originatorConversationId: 'SAF-V1-B', responseCode: '0', responseDescription: 'x' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).not.toHaveProperty('originatorConversationId');
  });

  it('explicit v3 + 403.002.1001: fails with the v3-specific three lines, never attempts v1', async () => {
    const send = vi.fn(async () => { throw gatewayRefusal(); });
    await deps.settings.set('env.sandbox.b2cApi', 'v3');
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
    expect(v.meaning).toBe("Safaricom's gateway did not allow this app to use the B2C v3 endpoint.");
    expect(v.whatToDo).toBe("In Settings, under this environment's Daraja app, set the B2C API version to v1 and send again. Nothing was sent.");
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row.payload_json.b2cApiUsed).toBe('v3');
    expect(await deps.settings.get('env.sandbox.b2cApiDetected')).toBeNull();
  });

  it('explicit v1 + 403.002.1001: fails with the general three lines, not the v3-specific ones', async () => {
    const send = vi.fn(async () => { throw gatewayRefusal(); });
    await deps.settings.set('env.sandbox.b2cApi', 'v1');
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    expect(v.whatToDo).not.toContain('set the B2C API version to v1');
  });

  it('auto + refusal, then the v1 retry ALSO fails: the row fails with that error\'s own three lines, no detection persisted', async () => {
    let call = 0;
    const send = vi.fn(async () => {
      call++;
      if (call === 1) throw gatewayRefusal();
      throw new DarajaAPIError('The initiator information is invalid.', { scope: 'b2c', raw: { ResponseCode: '2001', ResponseDescription: 'The initiator information is invalid.' } });
    });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(2);
    expect(v.safaricomSaid).toBe('The initiator information is invalid.');
    expect(await deps.settings.get('env.sandbox.b2cApiDetected')).toBeNull();
  });

  // A 5xx carrying 403.002.1001 in its body is not the gateway's "nothing
  // was queued" promise — it must be treated as maybe-queued (unknown), never retried on v1.
  it('auto + a 5xx carrying 403.002.1001: no v1 retry — the row goes unknown (maybe queued), exactly one SDK call', async () => {
    const send = vi.fn(async () => { throw Object.assign(new DarajaAPIError('Daraja request failed (HTTP 503)', { raw: { errorCode: '403.002.1001', errorMessage: 'x' } }), { httpStatus: 503 }); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row.payload_json.b2cApiUsed).toBe('v3');
    expect(await deps.settings.get('env.sandbox.b2cApiDetected')).toBeNull();
  });

  // Minor 5 (review): the guard "never retries once an ack exists" is enforced structurally (the
  // post-ack rejection is thrown outside the retry's own try/catch) — pin that with a send()-level
  // test, not just the predicate-level one, so a future refactor that moved the check would be caught.
  it('auto + a post-ack business rejection (ack.responseCode !== \'0\'): never retried, row failed, exactly one SDK call', async () => {
    const send = vi.fn(async () => ({ conversationId: 'AG_BAD', originatorConversationId: 'SAF-BAD', responseCode: '1', responseDescription: 'The initiator information is invalid.' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    expect(send).toHaveBeenCalledTimes(1);
  });

  // Minor 3 (review): the catch-all branch (an unexpected, non-Daraja error) also records
  // b2cApiUsed, like the other three failure branches — previously untested.
  it('an unexpected non-Daraja error also records b2cApiUsed on the failed row', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const svc = createMoneyOutService({ ...deps, daraja: factory(send, opId), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.status).toBe('failed');
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row.payload_json.b2cApiUsed).toBe('v3');
  });
});

// The retry in send() must never re-send a row Safaricom may already have accepted. A synchronous
// gateway refusal (no ack: no ConversationID, request never reached Safaricom's core) is the only
// safe case; anything carrying resultCode (our own post-ack rejection shape) must never retry.
// The gateway only makes this specific promise (nothing queued) on an actual HTTP 403 — a 5xx
// carrying the same error code in its body could still mean the request was queued before the
// upstream failure, so it must fall through to the existing maybeQueued ("unknown") handling
// instead of retrying.
describe('isV3GatewayRefusal (safety predicate for the auto v1 fallback)', () => {
  it('true for a raw synchronous HTTP 403 gateway rejection with no ack', () => {
    const e = Object.assign(new DarajaAPIError('x', { raw: { errorCode: '403.002.1001', errorMessage: 'x' } }), { httpStatus: 403 });
    expect(isV3GatewayRefusal(e)).toBe(true);
  });

  it('false once an ack already exists: a post-ack rejection carries resultCode, which a raw gateway rejection never does', () => {
    const e = Object.assign(new DarajaAPIError('x', { resultCode: 1, resultDesc: 'x', scope: 'b2c', raw: { errorCode: '403.002.1001' } }), { httpStatus: 403 });
    expect(isV3GatewayRefusal(e)).toBe(false);
  });

  it('false for a different error code', () => {
    const e = Object.assign(new DarajaAPIError('x', { raw: { errorCode: '500.001.1001', errorMessage: 'x' } }), { httpStatus: 403 });
    expect(isV3GatewayRefusal(e)).toBe(false);
  });

  it('false for a non-DarajaAPIError', () => {
    expect(isV3GatewayRefusal(new DarajaAuthError('x'))).toBe(false);
  });

  // A 5xx (or any non-403 status) carrying the same errorCode is NOT proof
  // that nothing was queued — the studio's own maybeQueued handling twenty lines away already
  // treats any DarajaAPIError with httpStatus >= 500 as "may already have reached Safaricom". The
  // two must agree: this predicate must refuse to fire for anything but an actual HTTP 403.
  it('false for a 5xx carrying the same error code — may mean the request was already queued', () => {
    const e = Object.assign(new DarajaAPIError('x', { raw: { errorCode: '403.002.1001', errorMessage: 'x' } }), { httpStatus: 503 });
    expect(isV3GatewayRefusal(e)).toBe(false);
  });

  it('false when no httpStatus is present at all (never assume 403)', () => {
    const e = new DarajaAPIError('x', { raw: { errorCode: '403.002.1001', errorMessage: 'x' } });
    expect(isV3GatewayRefusal(e)).toBe(false);
  });
});
