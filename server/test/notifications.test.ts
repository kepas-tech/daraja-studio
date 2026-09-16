import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAsOwner, resetTables, TEST_ORG_ID } from './helpers.js';
import { createNotificationsService } from '../src/notifications/service.js';
import { createNotificationWriter } from '../src/notifications/writer.js';
import { classify } from '../src/notifications/classify.js';
import type { RequestView } from '../src/money_out/reads.js';
import type { DarajaFactory } from '../src/sdk/client.js';

const ack = vi.fn(async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_C', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
const factory: DarajaFactory = {
  get: async () => ({}) as never,
  getForOperator: async () => ({ b2c: { send: ack }, config: { initiator: 'APIONE' } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
} as unknown as DarajaFactory;

const { app, deps, close } = makeApp({ daraja: factory });
afterAll(close);

const notifications = createNotificationsService({ db: deps.db, events: deps.events });
const writer = createNotificationWriter({ db: deps.db, events: deps.events, notifications });

/** A request view with sane defaults, so each test only names the field it is about. */
const view = (over: Partial<RequestView> = {}): RequestView => ({
  id: randomUUID(), type: 'b2c', subtype: 'BusinessPayment', status: 'completed', amountCents: 30000, currency: 'KES',
  recipient: { kind: 'phone', value: '254700123456', name: 'Joseph Ngumbao John' }, remarks: null, receipt: 'UIG517BUAZ',
  category: null, accountReference: null, createdAt: new Date().toISOString(), sentAt: null, resultAt: null, resultSource: null,
  safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0,
  checked: null, createdBy: null, approvedBy: null, bulkPlanId: null, contactName: null,
  businessId: null, customerId: null, businessName: null, customerName: null,
  ...over,
});

async function insertRequest(over: { type?: string; status?: string; amountCents?: number; name?: string | null; receipt?: string | null; desc?: string | null; raw?: unknown } = {}): Promise<string> {
  const [row] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name, receipt, result_desc, payload_json, raw_result_json)
     VALUES ($1,'BusinessPayment',$2,$3,$4,'KES','phone','254700123456',$5,$6,$7,'{}'::jsonb,$8::jsonb) RETURNING id`,
    [over.type ?? 'b2c', randomUUID(), over.status ?? 'completed', over.amountCents ?? 30000,
      over.name === undefined ? 'Joseph Ngumbao John' : over.name, over.receipt === undefined ? 'UIG517BUAZ' : over.receipt,
      over.desc ?? null, JSON.stringify(over.raw ?? {})]);
  return row.id;
}

/** One event straight through the writer: no hub, no timer, no waiting. */
const fire = (type: string, payload: unknown) => writer.handle({ type, payload, at: new Date().toISOString(), orgId: TEST_ORG_ID });
const rowsFor = (requestId: string) => deps.db.query<{ id: string; severity: string; category: string; body: string; count: number; read_at: Date | null }>(
  'SELECT id, severity, category, body, count, read_at FROM notifications WHERE data ->> $1 = $2', ['requestId', requestId]);

describe('notification classifier', () => {
  it('turns a completed send into a sentence with the name and the receipt', () => {
    const c = classify({ type: 'request.updated', payload: { status: 'completed' }, request: view() });
    expect(c).toMatchObject({ severity: 'success', category: 'money_out', title: 'Money sent', data: { requestId: expect.any(String) } });
    expect(c?.body).toBe('Sent KES 300 to Joseph Ngumbao John. They received it. Receipt UIG517BUAZ.');
  });

  it('prefers the owner\'s own saved name, and reads money in as received', () => {
    const out = classify({ type: 'request.updated', payload: { status: 'completed' }, request: view({ contactName: 'Mama Njeri' }) });
    expect(out?.body).toContain('Mama Njeri');
    const inbound = classify({ type: 'request.updated', payload: { status: 'completed' }, request: view({ type: 'c2b', receipt: 'UIG1', recipient: { kind: 'phone', value: '254700123456', name: 'Robert' } }) });
    expect(inbound).toMatchObject({ severity: 'success', category: 'money_in', title: 'Money received' });
    expect(inbound?.body).toBe('Received KES 300 from Robert. Receipt UIG1.');
  });

  it('answers null for an event it does not know and for the ordinary steps of a send', () => {
    expect(classify({ type: 'balance.updated', payload: { at: 'x' } })).toBeNull();
    expect(classify({ type: 'request.updated', payload: { status: 'pending' }, request: view({ status: 'pending' }) })).toBeNull();
    expect(classify({ type: 'request.updated', payload: { status: 'sent' }, request: view({ status: 'sent' }) })).toBeNull();
    expect(classify({ type: 'operator.updated', payload: { operatorId: 'x', status: 'verified' } })).toBeNull();
  });

  it('makes an operator failure critical, and a swept row speak through the alert event', () => {
    const op = classify({ type: 'operator.updated', payload: { operatorId: 'abc', status: 'failed' } });
    expect(op).toMatchObject({ severity: 'critical', category: 'operators', dedupeKey: 'operator:abc:failed' });
    const swept = classify({ type: 'alert', payload: { kind: 'request_unknown', id: 'x' }, request: view({ status: 'unknown' }) });
    expect(swept).toMatchObject({ severity: 'warning', type: 'request.unknown' });
    expect(swept?.body).toBe('No answer from Safaricom for KES 300 to Joseph Ngumbao John yet.');
  });
});

describe('notification writer and inbox', () => {
  let s: { cookie: string; csrf: string };
  beforeEach(async () => {
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
  });
  const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

  it('writes one line per status, with the severity the plan gives it', async () => {
    const wanted: [string, string][] = [['completed', 'success'], ['failed', 'warning'], ['unknown', 'warning'], ['awaiting_approval', 'info'], ['rejected', 'warning']];
    for (const [status, severity] of wanted) {
      const id = await insertRequest({ status });
      await fire('request.updated', { id, status });
      const rows = await rowsFor(id);
      expect(rows, status).toHaveLength(1);
      expect(rows[0].severity, status).toBe(severity);
    }
    await fire('operator.updated', { operatorId: randomUUID(), status: 'failed' });
    const [op] = await deps.db.query<{ severity: string }>('SELECT severity FROM notifications WHERE category = $1', ['operators']);
    expect(op.severity).toBe('critical');
    // Two rows of every status plus the operator line, and nothing else.
    const [total] = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications');
    expect(total.n).toBe(wanted.length + 1);
  });

  it('makes one row with count 2 when the same event happens twice, and a read line stays read', async () => {
    const id = await insertRequest({ status: 'failed' });
    await fire('request.updated', { id, status: 'failed' });
    const [first] = await rowsFor(id);
    expect(first.count).toBe(1);
    expect((await h(request(app).post('/api/notifications/' + first.id + '/read'))).status).toBe(204);
    await fire('request.updated', { id, status: 'failed' });
    const [again] = await rowsFor(id);
    expect(again.count).toBe(2);
    expect(again.read_at).not.toBeNull();
    const [count] = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications');
    expect(count.n).toBe(1);
  });

  it('lists newest first, hides what was read when asked, and counts the unread', async () => {
    const older = await insertRequest({ status: 'completed' });
    await fire('request.updated', { id: older, status: 'completed' });
    const newer = await insertRequest({ status: 'failed' });
    await fire('request.updated', { id: newer, status: 'failed' });

    const all = await request(app).get('/api/notifications').set('Cookie', s.cookie);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0].data.requestId).toBe(newer);
    expect(all.body.unread).toBe(2);
    expect(all.body.nextCursor).toBeNull();

    const [first] = await rowsFor(newer);
    expect((await h(request(app).post('/api/notifications/' + first.id + '/read'))).status).toBe(204);
    const unread = await request(app).get('/api/notifications?filter=unread').set('Cookie', s.cookie);
    expect(unread.body.items).toHaveLength(1);
    expect(unread.body.items[0].data.requestId).toBe(older);
    expect(unread.body.unread).toBe(1);
    const count = await request(app).get('/api/notifications/count').set('Cookie', s.cookie);
    expect(count.body).toEqual({ unread: 1 });
  });

  it('marks everything read and answers how many it changed', async () => {
    for (const status of ['completed', 'failed']) {
      const id = await insertRequest({ status });
      await fire('request.updated', { id, status });
    }
    const all = await h(request(app).post('/api/notifications/read-all'));
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ read: 2 });
    expect((await h(request(app).post('/api/notifications/read-all'))).body).toEqual({ read: 0 });
    expect((await request(app).get('/api/notifications/count').set('Cookie', s.cookie)).body).toEqual({ unread: 0 });
  });

  it('answers 404 for a notification that does not exist, and needs a session to read', async () => {
    expect((await h(request(app).post('/api/notifications/' + randomUUID() + '/read'))).status).toBe(404);
    expect((await request(app).get('/api/notifications')).status).toBe(401);
  });

  it('never copies Safaricom\'s raw JSON or a secret into a line', async () => {
    const id = await insertRequest({ status: 'failed', desc: 'The balance is insufficient', raw: { secret: 'ShouldNotAppear', rawResult: { x: 1 } } });
    await fire('request.updated', { id, status: 'failed' });
    const [row] = await rowsFor(id);
    expect(row.body).toBe('KES 300 to Joseph Ngumbao John did not go out. Safaricom said: The balance is insufficient');
    expect(row.body).not.toContain('ShouldNotAppear');
  });

  it('says nothing about a row it cannot load, and survives it', async () => {
    await expect(fire('request.updated', { id: randomUUID(), status: 'completed' })).resolves.toBeUndefined();
    const [count] = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications');
    expect(count.n).toBe(0);
  });
});
