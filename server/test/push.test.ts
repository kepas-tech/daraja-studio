import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAsOwner, makePerson, TEST_ORG_ID } from './helpers.js';
import { createNotificationsService } from '../src/notifications/service.js';
import { createNotificationWriter } from '../src/notifications/writer.js';
import { createPushService } from '../src/push/service.js';
import { vapidFromEnv } from '../src/push/config.js';
import type { PushMessage, PushResult, PushSender, PushTarget } from '../src/push/sender.js';

/** Shaped like a real pair (87 and 43 base64url characters) and obviously not one. */
const PUBLIC_KEY = 'B' + 'A'.repeat(86);
const PRIVATE_KEY = 'Z'.repeat(43);
const VAPID = {
  STUDIO_VAPID_PUBLIC_KEY: PUBLIC_KEY,
  STUDIO_VAPID_PRIVATE_KEY: PRIVATE_KEY,
  STUDIO_VAPID_SUBJECT: 'mailto:studio@example.com',
};
const ENDPOINT = 'https://push.example.test/send/abc123';
const ENDPOINT_B = 'https://push.example.test/send/def456';
const SUBSCRIPTION = { endpoint: ENDPOINT, keys: { p256dh: 'B'.repeat(87), auth: 'c'.repeat(22) } };

/** The push service is never reached: every test hands in this one instead. */
class FakeSender implements PushSender {
  calls: { target: PushTarget; message: PushMessage }[] = [];
  answer: PushResult = 'ok';
  private queue: PushResult[] = [];
  willAnswer(...answers: PushResult[]) { this.queue.push(...answers); }
  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    this.calls.push({ target, message });
    return this.queue.shift() ?? this.answer;
  }
}

describe('vapid keys from the environment', () => {
  it('reads a complete, well-shaped set', () => {
    expect(vapidFromEnv(VAPID)).toEqual({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, subject: 'mailto:studio@example.com' });
  });

  it('answers null when nothing is set, which is the supported off state', () => {
    expect(vapidFromEnv({})).toBeNull();
    expect(vapidFromEnv({ STUDIO_VAPID_PUBLIC_KEY: '' })).toBeNull();
  });

  it('warns and stays off for a half-filled or malformed set, rather than refusing to boot', () => {
    expect(vapidFromEnv({ STUDIO_VAPID_PUBLIC_KEY: PUBLIC_KEY })).toBeNull();
    expect(vapidFromEnv({ ...VAPID, STUDIO_VAPID_PUBLIC_KEY: 'B' + 'A'.repeat(85) })).toBeNull();
    expect(vapidFromEnv({ ...VAPID, STUDIO_VAPID_PRIVATE_KEY: 'too-short' })).toBeNull();
    expect(vapidFromEnv({ ...VAPID, STUDIO_VAPID_SUBJECT: 'a phone number' })).toBeNull();
  });
});

describe('web push with no keys on the deployment', () => {
  const { app, deps, close } = makeApp();
  afterAll(close);

  it('answers 401 to a stranger and configured:false to a signed-in person', async () => {
    expect((await request(app).get('/api/push/key')).status).toBe(401);
    const { cookie } = await loginAsOwner(app, deps);
    const r = await request(app).get('/api/push/key').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ configured: false, publicKey: null });
  });

  it('refuses a subscription and a test with a sentence, not a crash', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    const sub = await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    expect(sub.status).toBe(409);
    expect(sub.body.error.code).toBe('push_off');
    const test = await request(app).post('/api/push/test').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(test.status).toBe(409);
  });

  it('sends nothing when the writer runs', async () => {
    const notifications = createNotificationsService({ db: deps.db, events: deps.events });
    const writer = createNotificationWriter({ db: deps.db, events: deps.events, notifications, push: deps.push });
    await writer.handle({ type: 'operator.updated', payload: { operatorId: randomUUID(), status: 'failed' }, at: new Date().toISOString(), orgId: TEST_ORG_ID });
    // The inbox row is written; there is simply no device to send it to.
    const [row] = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM push_subscriptions');
    expect(row.n).toBe(0);
  });
});

describe('web push with keys', () => {
  const sender = new FakeSender();
  const { app, deps, close } = makeApp({ env: VAPID, pushSender: sender });
  afterAll(close);

  const personId = async () => {
    const [row] = await deps.db.query<{ id: string }>("SELECT id FROM people WHERE username = 'owner'");
    return row.id;
  };
  const liveRows = () => deps.db.query<{ id: string; person_id: string; endpoint: string; gone_at: Date | null; failures: number }>(
    'SELECT id, person_id, endpoint, gone_at, failures FROM push_subscriptions ORDER BY created_at');

  it('hands the browser the public half, never the private one', async () => {
    const { cookie } = await loginAsOwner(app, deps);
    const r = await request(app).get('/api/push/key').set('Cookie', cookie);
    expect(r.body).toEqual({ configured: true, publicKey: PUBLIC_KEY });
    expect(JSON.stringify(r.body)).not.toContain(PRIVATE_KEY);
  });

  it('stores one row per device, is idempotent, and refuses a body it cannot trust', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    const first = await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ devices: 1 });
    const again = await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    expect(again.body).toEqual({ devices: 1 });
    const other = await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send({ ...SUBSCRIPTION, endpoint: ENDPOINT_B });
    expect(other.body).toEqual({ devices: 2 });
    expect((await liveRows()).length).toBe(2);
    expect((await liveRows())[0].person_id).toBe(await personId());

    const http = await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send({ ...SUBSCRIPTION, endpoint: 'http://push.example.test/send/abc' });
    expect(http.status).toBe(400);
    const thin = await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send({ endpoint: ENDPOINT, keys: { p256dh: 'short', auth: 'x' } });
    expect(thin.status).toBe(400);
    expect((await liveRows()).length).toBe(2);
  });

  it('keeps every write in the audit log without the device address', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    await request(app).post('/api/push/unsubscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send({ endpoint: ENDPOINT });
    const me = await personId();
    const actions = await deps.db.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'push.%' AND person_id = $1 ORDER BY id", [me]);
    expect(actions.map((a) => a.action)).toEqual(['push.subscription_added', 'push.subscription_removed']);
    // The endpoint is a capability: it must not appear anywhere in the log, in either json column.
    const leaked = await deps.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'push.%' AND (coalesce(after_json::text,'') || coalesce(before_json::text,'')) LIKE '%' || $1 || '%'",
      [ENDPOINT]);
    expect(leaked[0].n).toBe(0);
    // Unsubscribing twice is harmless and writes nothing the second time.
    const second = await request(app).post('/api/push/unsubscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send({ endpoint: ENDPOINT });
    expect(second.status).toBe(204);
    const removed = await deps.db.query("SELECT 1 FROM audit_log WHERE action = 'push.subscription_removed' AND person_id = $1", [me]);
    expect(removed.length).toBe(1);
  });

  it('will not let one person remove another person\'s device', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    await makePerson(deps.db, TEST_ORG_ID, { username: 'second', password: 'correct horse' });
    const other = await request(app).post('/api/auth/login').send({ username: 'second', password: 'correct horse' });
    const removed = await request(app).post('/api/push/unsubscribe')
      .set('Cookie', other.headers['set-cookie'][0]).set('x-csrf-token', other.body.csrf).send({ endpoint: ENDPOINT });
    expect(removed.status).toBe(204);
    expect((await liveRows()).length).toBe(1);
  });

  it('sends the inbox line to the subscribed device, with the same words and a link', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    sender.calls.length = 0;
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name, receipt, payload_json, raw_result_json)
       VALUES ('b2c','BusinessPayment',$1,'completed',30000,'KES','phone','254700123456','Joseph Ngumbao John','UIG517BUAZ','{}'::jsonb,'{}'::jsonb) RETURNING id`,
      [randomUUID()]);
    const notifications = createNotificationsService({ db: deps.db, events: deps.events });
    const writer = createNotificationWriter({ db: deps.db, events: deps.events, notifications, push: deps.push });
    await writer.handle({ type: 'request.updated', payload: { id: row.id, status: 'completed' }, at: new Date().toISOString(), orgId: TEST_ORG_ID });
    expect(sender.calls.length).toBe(1);
    expect(sender.calls[0].target.endpoint).toBe(ENDPOINT);
    expect(sender.calls[0].message).toEqual({
      title: 'Money sent',
      body: 'Sent KES 300 to Joseph Ngumbao John. They received it. Receipt UIG517BUAZ.',
      tag: 'request:' + row.id + ':completed',
      url: '/requests/' + row.id,
    });
    // And the same words are in the inbox, so the two can never drift apart.
    const [line] = await deps.db.query<{ body: string }>('SELECT body FROM notifications WHERE org_id = $1', [TEST_ORG_ID]);
    expect(line.body).toBe(sender.calls[0].message.body);
  });

  it('marks a dead address gone on a 410 and never sends to it again', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    const notifications = createNotificationsService({ db: deps.db, events: deps.events });
    const writer = createNotificationWriter({ db: deps.db, events: deps.events, notifications, push: deps.push });
    sender.calls.length = 0;
    sender.willAnswer('gone');
    await writer.handle({ type: 'operator.updated', payload: { operatorId: randomUUID(), status: 'failed' }, at: new Date().toISOString(), orgId: TEST_ORG_ID });
    expect((await liveRows())[0].gone_at).not.toBeNull();
    sender.answer = 'ok';
    await writer.handle({ type: 'operator.updated', payload: { operatorId: randomUUID(), status: 'failed' }, at: new Date().toISOString(), orgId: TEST_ORG_ID });
    expect(sender.calls.length).toBe(1);
  });

  it('gives up on a device after five failures in a row', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    const service = createPushService({ db: deps.db, vapid: vapidFromEnv(VAPID), sender });
    sender.calls.length = 0;
    sender.answer = 'failed';
    for (let i = 0; i < 5; i += 1) {
      await service.notify({ severity: 'info', category: 'operators', type: 'operator.failed', title: 'Operator problem', body: 'The operator stopped working.', data: {}, dedupeKey: 'operator:x:failed' });
    }
    expect((await liveRows())[0].failures).toBe(5);
    expect((await liveRows())[0].gone_at).not.toBeNull();
    expect(sender.calls.length).toBe(5);
    sender.answer = 'ok';
    await service.notify({ severity: 'info', category: 'operators', type: 'operator.failed', title: 'Operator problem', body: 'The operator stopped working.', data: {}, dedupeKey: 'operator:x:failed' });
    expect(sender.calls.length).toBe(5);
  });

  it('writes the inbox row even when the sender throws', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    const throwing = createPushService({ db: deps.db, vapid: vapidFromEnv(VAPID), sender: { send: async () => { throw new Error('the push service is a puddle'); } } });
    const notifications = createNotificationsService({ db: deps.db, events: deps.events });
    const writer = createNotificationWriter({ db: deps.db, events: deps.events, notifications, push: throwing });
    await writer.handle({ type: 'operator.updated', payload: { operatorId: randomUUID(), status: 'failed' }, at: new Date().toISOString(), orgId: TEST_ORG_ID });
    const [n] = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications');
    expect(n.n).toBe(1);
    expect((await liveRows())[0].failures).toBe(1);
  });

  it('sends a test to the caller\'s own devices and answers how many', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    await request(app).post('/api/push/subscribe').set('Cookie', cookie).set('x-csrf-token', csrf).send(SUBSCRIPTION);
    sender.calls.length = 0;
    sender.answer = 'ok';
    const r = await request(app).post('/api/push/test').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ sent: 1, failed: 0 });
    expect(sender.calls[0].message.tag).toBe('push-test');
  });
});
