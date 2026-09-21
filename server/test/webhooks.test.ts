import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { testDeps, resetTables, makeApp, loginAsOwner, makePerson, loginAs, TEST_ORG_ID } from './helpers.js';
import { createWebhooksService } from '../src/webhooks/service.js';
import { createApiKeysService } from '../src/keys/service.js';
import { createWebhookDispatcher, MAX_ATTEMPTS, RETRY_SECONDS } from '../src/webhooks/dispatcher.js';
import { createWebhookWriter } from '../src/webhooks/writer.js';
import { createModuleService } from '../src/modules/service.js';
import { verifyWebhook } from '../src/webhooks/signing.js';
import type { EventHub } from '../src/events/hub.js';

/**
 * Round 3, phase E: webhooks.
 *
 * One address per organisation, a secret shown once and stored encrypted, a delivery signed the
 * way the receiver checks it, and the retry curve 1m / 5m / 30m / 2h / 6h / 24h with six attempts.
 */
const deps = testDeps();
afterAll(() => deps.db.end());

const service = () => createWebhooksService({ db: deps.db, keyring: deps.keyring });

interface Sent { url: string; body: string; headers: Record<string, string> }
function fakeFetch(answer: () => { status: number; body?: string }): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? ''), headers: (init?.headers ?? {}) as Record<string, string> });
    const a = answer();
    return new Response(a.body ?? '', { status: a.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

// Step one: the dispatcher asks whether the developer side is on, so it takes the same service
// the routes and the page take.
const modules = createModuleService({ db: deps.db, settings: deps.settings });

function dispatcher(fetchImpl: typeof fetch) {
  return createWebhookDispatcher({ db: deps.db, keyring: deps.keyring, modules, fetchImpl });
}

async function due(id: string) {
  await deps.db.query('UPDATE webhook_deliveries SET next_retry_at = now() WHERE id = $1', [id]);
}

async function row(id: string) {
  const [r] = await deps.db.query<{ attempts: number; last_status: number | null; last_response: string | null; next_retry_at: Date | null; delivered_at: Date | null }>(
    'SELECT attempts, last_status, last_response, next_retry_at, delivered_at FROM webhook_deliveries WHERE id = $1', [id]);
  return r!;
}

describe('webhooks', () => {
  // The audit rows need a person; `resetTables` removes them all, so one is made per test.
  let actor: { personId: string; ip: string };
  beforeEach(async () => {
    await resetTables(deps.db);
    const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
    actor = { personId: p!.id, ip: '1.1.1.1' };
  });

  it('makes a secret on the first save, keeps it on the next, and never shows it again', async () => {
    const w = service();
    expect(await w.get()).toEqual({ url: null, secretHint: null, updatedAt: null });

    const first = await w.save('https://example.test/hooks/studio', actor);
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.webhook.url).toBe('https://example.test/hooks/studio');
    expect(first.webhook.secretHint).toBe(first.secret!.slice(-4));

    const again = await w.save('https://example.test/hooks/two', actor);
    expect(again.secret).toBeNull();
    expect(again.webhook.url).toBe('https://example.test/hooks/two');
    expect(again.webhook.secretHint).toBe(first.secret!.slice(-4));

    // Stored encrypted, and the plain secret is nowhere a read can reach it.
    const [stored] = await deps.db.query<{ secret_enc: string }>('SELECT secret_enc FROM webhooks');
    expect(stored!.secret_enc).not.toContain(first.secret!);
    expect(JSON.stringify(await w.get())).not.toContain(first.secret!);

    // Rotating makes a new one, and the hint moves with it.
    const rotated = await w.rotateSecret(actor);
    expect(rotated.secret).not.toBe(first.secret);
    expect(rotated.webhook.secretHint).toBe(rotated.secret!.slice(-4));
    const audit = await deps.db.query<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE 'webhook%' ORDER BY action`);
    expect(audit.map((a) => a.action)).toEqual(['webhook.created', 'webhook.saved', 'webhook.secret_rotated']);
    for (const a of await deps.db.query<{ after_json: unknown }>('SELECT after_json FROM audit_log')) {
      expect(JSON.stringify(a.after_json)).not.toContain(first.secret!);
    }
  });

  it('refuses an address that is not a public https one', async () => {
    const w = service();
    const bad = ['http://example.test/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://10.0.0.5/hook', 'https://192.168.1.10/hook', 'https://user:pw@example.test/hook', 'not a url'];
    for (const url of bad) {
      await expect(w.save(url, actor)).rejects.toMatchObject({ code: 'bad_url' });
    }
    expect(await deps.db.query('SELECT 1 FROM webhooks')).toHaveLength(0);
  });

  it('delivers with a signature the receiver can verify', async () => {
    const w = service();
    const saved = await w.save('https://example.test/hooks/studio', actor);
    const secret = saved.secret!;

    const made = await w.enqueue('request.completed', { event: 'request.completed', id: 'r1', amountCents: 25000 }, null);
    expect(made).not.toBeNull();
    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200, body: 'ok' }));
    const out = await dispatcher(fetchImpl).dispatchOnce();
    expect(out).toEqual({ sent: 1, failed: 0, given: 0 });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://example.test/hooks/studio');
    expect(sent[0]!.headers['x-studio-event']).toBe('request.completed');
    expect(verifyWebhook({ rawBody: sent[0]!.body, secret, header: sent[0]!.headers['x-studio-signature']! })).toBe(true);
    // The body is the payload, exactly as serialised.
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ event: 'request.completed', id: 'r1', amountCents: 25000 });

    const after = await row(made!.id);
    expect(after).toMatchObject({ attempts: 1, last_status: 200, next_retry_at: null });
    expect(after.delivered_at).toBeTruthy();
  });

  it('walks the retry curve, then gives up after the sixth attempt', async () => {
    const w = service();
    await w.save('https://example.test/hooks/studio', actor);
    const made = await w.enqueue('request.failed', { event: 'request.failed', id: 'r2' }, null);
    const { fetchImpl, sent } = fakeFetch(() => ({ status: 500, body: 'x'.repeat(600) }));
    const d = dispatcher(fetchImpl);

    for (let i = 1; i <= 5; i += 1) {
      const out = await d.dispatchOnce();
      expect(out).toEqual({ sent: 0, failed: 1, given: 0 });
      const r = await row(made!.id);
      expect(r.attempts).toBe(i);
      expect(r.last_status).toBe(500);
      expect(r.last_response).toHaveLength(512);
      const waitMs = r.next_retry_at!.getTime() - Date.now();
      expect(waitMs).toBeGreaterThan(RETRY_SECONDS[i - 1]! * 1000 - 5_000);
      expect(waitMs).toBeLessThanOrEqual(RETRY_SECONDS[i - 1]! * 1000 + 5_000);
      await due(made!.id);
    }

    const out = await d.dispatchOnce();
    expect(out).toEqual({ sent: 0, failed: 0, given: 1 });
    const last = await row(made!.id);
    expect(last.attempts).toBe(MAX_ATTEMPTS);
    expect(last.next_retry_at).toBeNull();
    expect(last.delivered_at).toBeNull();

    // A person can put it back in the queue. That buys one more try, not a fresh curve: it is
    // posted once, and a second failure leaves it failed for a person again — who can press
    // Retry again, as many times as they like.
    const again = await w.retry(made!.id, actor);
    expect(again.state).toBe('pending');
    expect(again.nextRetryAt).toBeTruthy();
    const before = sent.length;
    expect(await d.dispatchOnce()).toEqual({ sent: 0, failed: 0, given: 1 });
    expect(sent.length).toBe(before + 1);
    expect((await row(made!.id)).attempts).toBe(MAX_ATTEMPTS + 1);
    const states = await w.listDeliveries({ state: 'failed', limit: 10 });
    expect(states.map((s) => s.id)).toEqual([made!.id]);
  });

  it('forgets the deliveries that are not coming back, and keeps the ones that arrived', async () => {
    const w = service();
    await w.save('https://example.test/hooks/studio', actor);
    await deps.db.query(
      `INSERT INTO webhook_deliveries(event, url, payload, delivered_at) VALUES ('request.completed','https://example.test/hooks/studio','{}'::jsonb, now())`);
    const [waiting] = await deps.db.query<{ id: string }>(
      `INSERT INTO webhook_deliveries(event, url, payload, next_retry_at) VALUES ('request.completed','https://example.test/hooks/studio','{}'::jsonb, now() + interval '1 hour') RETURNING id`);
    const [gaveUp] = await deps.db.query<{ id: string }>(
      `INSERT INTO webhook_deliveries(event, url, payload, next_retry_at) VALUES ('request.failed','https://example.test/hooks/studio','{}'::jsonb, NULL) RETURNING id`);

    // The ones that gave up go first, and nothing else moves.
    expect(await w.clear('failed', actor)).toBe(1);
    expect(await deps.db.query('SELECT 1 FROM webhook_deliveries WHERE id = $1', [gaveUp!.id])).toHaveLength(0);
    expect(await deps.db.query('SELECT 1 FROM webhook_deliveries')).toHaveLength(2);

    // Everything still waiting goes too, when asked. What arrived is the record of the receiver's
    // own answers, and no asking removes it; asking twice is not an error, it is nothing to do.
    expect(await w.clear('all', actor)).toBe(1);
    expect(await deps.db.query('SELECT 1 FROM webhook_deliveries WHERE id = $1', [waiting!.id])).toHaveLength(0);
    expect(await deps.db.query('SELECT 1 FROM webhook_deliveries')).toHaveLength(1);
    expect(await w.clear('all', actor)).toBe(0);
    expect(await w.clear('failed', actor)).toBe(0);

    // One row says what was forgotten and how much of it; no address and no payload goes with it.
    const audit = await deps.db.query<{ after_json: { state: string; removed: number } }>(
      `SELECT after_json FROM audit_log WHERE action = 'webhook.deliveries_cleared' ORDER BY id`);
    expect(audit.map((a) => a.after_json.removed)).toEqual([1, 1]);
    expect(audit.map((a) => a.after_json.state)).toEqual(['failed', 'all']);
  });

  it('refuses an address that points inside the network, and never retries it', async () => {
    const w = service();
    await w.save('https://example.test/hooks/studio', actor);
    // Written straight into the table: save refuses this, and the dispatcher must too, whatever
    // put the row there.
    const [made] = await deps.db.query<{ id: string }>(
      `INSERT INTO webhook_deliveries(event, url, payload, webhook_id) VALUES ('request.failed','https://10.1.2.3/hook','{}'::jsonb, (SELECT id FROM webhooks LIMIT 1)) RETURNING id`);
    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200 }));
    expect(await dispatcher(fetchImpl).dispatchOnce()).toEqual({ sent: 0, failed: 0, given: 1 });
    expect(sent).toHaveLength(0);
    const r = await row(made!.id);
    expect(r.next_retry_at).toBeNull();
    expect(r.last_response).toMatch(/^blocked: /);
  });

  it('attempts nothing while the developer side is off, and sends the backlog when it is on again', async () => {
    const w = service();
    await w.save('https://example.test/hooks/studio', actor);
    const [made] = await deps.db.query<{ id: string }>(
      `INSERT INTO webhook_deliveries(event, url, payload, webhook_id) VALUES ('request.completed','https://example.test/hooks/studio','{}'::jsonb, (SELECT id FROM webhooks LIMIT 1)) RETURNING id`);

    // Off: nothing leaves, and the row is left exactly where it was — same attempt count, still
    // due — so a pause cannot quietly spend an attempt or drop a delivery. The feed stands on the
    // developer side, so it goes first: that rule is what keeps a machine's key from outliving the
    // part it belongs to.
    await modules.set('feed', false, actor);
    await modules.set('developer', false, actor);
    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200 }));
    expect(await dispatcher(fetchImpl).dispatchOnce()).toEqual({ sent: 0, failed: 0, given: 0 });
    expect(sent).toHaveLength(0);
    const held = await row(made!.id);
    expect(held).toMatchObject({ attempts: 0, delivered_at: null, last_status: null });
    expect(held.next_retry_at).not.toBeNull();

    // On again: the backlog goes, and nothing was lost by the pause.
    await modules.set('developer', true, actor);
    expect(await dispatcher(fetchImpl).dispatchOnce()).toEqual({ sent: 1, failed: 0, given: 0 });
    expect((await row(made!.id)).delivered_at).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('turns a payment event into a delivery with the same facts the page shows', async () => {
    const w = service();
    await w.save('https://example.test/hooks/studio', actor);
    const [req] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name, receipt, result_at)
       VALUES ('b2c','BusinessPayment','oc-hook','completed',25000,'KES','phone','254700123456','Jane Doe','RI6BZTPXNM', now()) RETURNING id`);
    const events = { subscribe: () => () => {} } as unknown as EventHub;
    const writer = createWebhookWriter({ db: deps.db, events, webhooks: w });
    await writer.handle({ type: 'request.updated', payload: { id: req!.id }, at: new Date().toISOString(), orgId: TEST_ORG_ID } as never);

    const items = await w.listDeliveries({ state: 'all', limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ event: 'request.completed', requestId: req!.id, state: 'pending', attempts: 0 });
    const [d] = await deps.db.query<{ payload: Record<string, unknown> }>('SELECT payload FROM webhook_deliveries');
    expect(d!.payload).toMatchObject({ event: 'request.completed', status: 'completed', amountCents: 25000, receipt: 'RI6BZTPXNM' });
  });

/**
   * Step six, part five: an address may belong to a key, not only to the organisation. The cases
   * below are the ones that are easy to get wrong — who gets a notice no key asked for, what a
   * stopped key's queue does, and what a notice already written does when its address moves.
   */
  const apiKeys = () => createApiKeysService({ db: deps.db });
  const makeKey = async (name: string) => (await apiKeys().create({ name, role: 'collector' }, actor)).key;

  it('sends a key its own address, and everything else the organisation address', async () => {
    const w = service();
    const org = await w.save('https://example.test/hooks/org', actor);
    const key = await makeKey('A system');
    const own = await w.forKey(key.id).save('https://example.test/hooks/key', actor);

    // One notice for a payment the key asked for, and one for a payment no key asked for.
    const forKey = await w.enqueue('request.completed', { event: 'request.completed', id: 'r-key' }, null, key.id);
    const forOrg = await w.enqueue('request.completed', { event: 'request.completed', id: 'r-org' }, null, null);
    expect(forKey).not.toBeNull();
    expect(forOrg).not.toBeNull();

    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200, body: 'ok' }));
    expect(await dispatcher(fetchImpl).dispatchOnce()).toEqual({ sent: 2, failed: 0, given: 0 });
    const byUrl = new Map(sent.map((s) => [s.url, s]));
    expect([...byUrl.keys()].sort()).toEqual(['https://example.test/hooks/key', 'https://example.test/hooks/org']);

    // Each went to its own address, signed with that address's own secret, and neither secret
    // verifies the other address's notice.
    const keySent = byUrl.get('https://example.test/hooks/key')!;
    const orgSent = byUrl.get('https://example.test/hooks/org')!;
    expect(verifyWebhook({ rawBody: keySent.body, secret: own.secret!, header: keySent.headers['x-studio-signature']! })).toBe(true);
    expect(verifyWebhook({ rawBody: orgSent.body, secret: org.secret!, header: orgSent.headers['x-studio-signature']! })).toBe(true);
    expect(verifyWebhook({ rawBody: orgSent.body, secret: own.secret!, header: orgSent.headers['x-studio-signature']! })).toBe(false);
    expect(JSON.parse(keySent.body)).toMatchObject({ id: 'r-key' });
    expect(JSON.parse(orgSent.body)).toMatchObject({ id: 'r-org' });
  }, 60_000);

  it('falls back to the organisation address when a key holds none of its own', async () => {
    const w = service();
    const org = await w.save('https://example.test/hooks/org', actor);
    const key = await makeKey('No address of its own');

    // Reading answers with the organisation's, because that is where its notices go.
    expect(await w.forKey(key.id).get()).toEqual(org.webhook);
    expect((await w.heldByKeys()).size).toBe(0);

    await w.enqueue('request.failed', { event: 'request.failed', id: 'r1' }, null, key.id);
    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200 }));
    expect(await dispatcher(fetchImpl).dispatchOnce()).toEqual({ sent: 1, failed: 0, given: 0 });
    expect(sent[0]!.url).toBe('https://example.test/hooks/org');
    expect(verifyWebhook({ rawBody: sent[0]!.body, secret: org.secret!, header: sent[0]!.headers['x-studio-signature']! })).toBe(true);
  }, 60_000);

  it('keeps every address secret its own: one rotation touches no other receiver', async () => {
    const w = service();
    const org = await w.save('https://example.test/hooks/org', actor);
    const a = await makeKey('A');
    const b = await makeKey('B');
    const ownA = await w.forKey(a.id).save('https://example.test/hooks/a', actor);
    const ownB = await w.forKey(b.id).save('https://example.test/hooks/b', actor);

    const rotated = await w.forKey(a.id).rotateSecret(actor);
    expect(rotated.secret).not.toBe(ownA.secret);
    expect((await w.get()).secretHint).toBe(org.secret!.slice(-4));
    expect((await w.forKey(b.id).get()).secretHint).toBe(ownB.secret!.slice(-4));
    // And the list of what keys hold themselves shows both, with their own hints.
    expect([...(await w.heldByKeys()).keys()].sort()).toEqual([a.id, b.id].sort());

    // A key with no address of its own is refused rather than changing the organisation's secret,
    // which every other receiver shares.
    const c = await makeKey('C');
    await expect(w.forKey(c.id).rotateSecret(actor)).rejects.toMatchObject({ code: 'no_webhook' });
    expect((await w.get()).secretHint).toBe(org.secret!.slice(-4));

    await w.enqueue('request.completed', { event: 'request.completed', id: 'ra' }, null, a.id);
    await w.enqueue('request.completed', { event: 'request.completed', id: 'rb' }, null, b.id);
    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200 }));
    await dispatcher(fetchImpl).dispatchOnce();
    const byUrl = new Map(sent.map((s) => [s.url, s]));
    expect(verifyWebhook({ rawBody: byUrl.get('https://example.test/hooks/a')!.body, secret: rotated.secret!, header: byUrl.get('https://example.test/hooks/a')!.headers['x-studio-signature']! })).toBe(true);
    expect(verifyWebhook({ rawBody: byUrl.get('https://example.test/hooks/b')!.body, secret: ownB.secret!, header: byUrl.get('https://example.test/hooks/b')!.headers['x-studio-signature']! })).toBe(true);
  }, 60_000);

  it('keeps sending the notices a stopped key already owes, to the address it was given', async () => {
    const w = service();
    await w.save('https://example.test/hooks/org', actor);
    const key = await makeKey('Stopped while queued');
    await w.forKey(key.id).save('https://example.test/hooks/key', actor);
    const queued = await w.enqueue('request.failed', { event: 'request.failed', id: 'r1' }, null, key.id);
    expect(queued).not.toBeNull();

    // The key is revoked with its delivery still queued. The queue keeps its promise: the notice
    // already written goes, and a notice written after the stop for a payment the key asked for
    // before it goes to the same address. Nothing falls back to the organisation behind the
    // receiver's back.
    await apiKeys().revoke(key.id, actor);
    await w.enqueue('request.completed', { event: 'request.completed', id: 'r1' }, null, key.id);

    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200 }));
    expect(await dispatcher(fetchImpl).dispatchOnce()).toEqual({ sent: 2, failed: 0, given: 0 });
    expect(sent.map((s) => s.url)).toEqual(['https://example.test/hooks/key', 'https://example.test/hooks/key']);

    // Only when the address is taken away does the key fall back to the organisation's.
    await w.forKey(key.id).remove(actor);
    expect((await w.forKey(key.id).get()).url).toBe('https://example.test/hooks/org');
  }, 60_000);

  it('keeps a queued notice on the address it was written for when the address moves', async () => {
    const w = service();
    await w.save('https://example.test/hooks/org', actor);
    const key = await makeKey('Moved underneath');
    const own = await w.forKey(key.id).save('https://example.test/hooks/old', actor);
    await w.enqueue('request.failed', { event: 'request.failed', id: 'old-one' }, null, key.id);

    // The address changes; saving keeps the secret, so the receiver is set up once.
    const moved = await w.forKey(key.id).save('https://example.test/hooks/new', actor);
    expect(moved.secret).toBeNull();
    expect(moved.webhook.secretHint).toBe(own.webhook.secretHint);
    await w.enqueue('request.failed', { event: 'request.failed', id: 'new-one' }, null, key.id);

    const { fetchImpl, sent } = fakeFetch(() => ({ status: 200 }));
    await dispatcher(fetchImpl).dispatchOnce();
    const byUrl = new Map(sent.map((s) => [s.url, s]));
    // The notice written first still goes to the address it was written for; the one written after
    // the move goes to the new one. Both are signed with the secret that belongs to the address.
    expect([...byUrl.keys()].sort()).toEqual(['https://example.test/hooks/new', 'https://example.test/hooks/old']);
    expect(verifyWebhook({ rawBody: byUrl.get('https://example.test/hooks/old')!.body, secret: own.secret!, header: byUrl.get('https://example.test/hooks/old')!.headers['x-studio-signature']! })).toBe(true);
    const listed = await w.listDeliveries({ state: 'delivered', limit: 10 });
    expect(listed.map((d) => d.url).sort()).toEqual(['https://example.test/hooks/new', 'https://example.test/hooks/old']);
    expect(listed.every((d) => d.keyName === 'Moved underneath')).toBe(true);
  }, 60_000);

  it('takes only one address own queue away when that address is removed', async () => {
    const w = service();
    await w.save('https://example.test/hooks/org', actor);
    const a = await makeKey('A');
    const b = await makeKey('B');
    await w.forKey(a.id).save('https://example.test/hooks/a', actor);
    await w.forKey(b.id).save('https://example.test/hooks/b', actor);
    await w.enqueue('request.failed', { event: 'request.failed', id: 'r-org' }, null, null);
    await w.enqueue('request.failed', { event: 'request.failed', id: 'r-a' }, null, a.id);
    await w.enqueue('request.failed', { event: 'request.failed', id: 'r-b' }, null, b.id);

    await w.forKey(a.id).remove(actor);
    let left = await w.listDeliveries({ state: 'all', limit: 10 });
    expect(left.map((d) => d.url).sort()).toEqual(['https://example.test/hooks/b', 'https://example.test/hooks/org']);
    expect(left.find((d) => d.url === 'https://example.test/hooks/b')!.keyName).toBe('B');

    // Removing the organisation's own address takes only the organisation's own queue: a key's
    // receiver is not the organisation's to silence.
    await w.remove(actor);
    left = await w.listDeliveries({ state: 'all', limit: 10 });
    expect(left.map((d) => d.url)).toEqual(['https://example.test/hooks/b']);
  }, 60_000);

  it('refuses a key that does not exist, rather than writing an address for nobody', async () => {
    const w = service();
    await expect(w.forKey('11111111-1111-4111-8111-111111111111').save('https://example.test/hooks/x', actor))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await deps.db.query('SELECT 1 FROM webhooks')).toHaveLength(0);
  }, 60_000);

  it('is the owner alone, over the routes', async () => {
    const { app, deps: appDeps, close } = makeApp();
    try {
      const s = await loginAsOwner(app, appDeps);
      const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
      const saved = await h(request(app).put('/api/webhooks')).send({ url: 'https://example.test/hooks/studio' });
      expect(saved.status).toBe(200);
      expect(saved.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await h(request(app).get('/api/webhooks'))).body.webhook).toMatchObject({ url: 'https://example.test/hooks/studio' });

      // Clearing what gave up is the owner's own call, and it answers with the count.
      await appDeps.db.query(`INSERT INTO webhook_deliveries(event, url, payload, next_retry_at) VALUES ('request.failed','https://example.test/hooks/studio','{}'::jsonb, NULL)`);
      const cleared = await h(request(app).delete('/api/webhooks/deliveries?state=failed'));
      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ removed: 1 });

      await makePerson(appDeps.db, TEST_ORG_ID, { username: 'staff', password: 'correct horse', role: 'operator' });
      const staff = await loginAs(app, 'staff', 'correct horse');
      const refused = await request(app).get('/api/webhooks').set('Cookie', staff.cookie);
      expect(refused.status).toBe(403);
    } finally { await close(); }
  }, 60_000);

  it('gives a key its own address in the same breath, and hands it to a replacement', async () => {
    const { app, deps: appDeps, close } = makeApp();
    try {
      const s = await loginAsOwner(app, appDeps);
      const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

      // A key and its address named in one answer: the key's own secret, and the address's.
      const made = await h(request(app).post('/api/keys')).send({ name: 'A system', role: 'collector', webhookUrl: 'https://example.test/hooks/key' });
      expect(made.status).toBe(201);
      expect(made.body.secret).toMatch(/^studio_/);
      expect(made.body.webhook.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(made.body.webhook.webhook.url).toBe('https://example.test/hooks/key');

      // The list says what each key holds itself, and where a key with none would go.
      let list = await h(request(app).get('/api/keys'));
      expect(list.body.items[0].webhook).toMatchObject({ url: 'https://example.test/hooks/key' });
      expect(list.body.organisation).toEqual({ url: null, secretHint: null, updatedAt: null });

      // A bad address is refused before any key is made.
      const bad = await h(request(app).post('/api/keys')).send({ name: 'Bad address', role: 'viewer', webhookUrl: 'https://10.0.0.1/hook' });
      expect(bad.status).toBe(400);
      list = await h(request(app).get('/api/keys'));
      expect(list.body.items.filter((k: { name: string }) => k.name === 'Bad address')).toHaveLength(0);

      // Changing the address keeps the secret; a new secret is this key's own business.
      const moved = await h(request(app).put(`/api/keys/${made.body.key.id}/webhook`)).send({ url: 'https://example.test/hooks/moved' });
      expect(moved.status).toBe(200);
      expect(moved.body.secret).toBeNull();
      expect(moved.body.webhook.secretHint).toBe(made.body.webhook.webhook.secretHint);
      const fresh = await h(request(app).post(`/api/keys/${made.body.key.id}/webhook/secret`));
      expect(fresh.status).toBe(200);
      expect(fresh.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fresh.body.webhook.secretHint).toBe(fresh.body.secret.slice(-4));

      // Replacing the key hands the receiver over, address and secret together, so no receiver
      // is reconfigured by a rotation.
      const replaced = await h(request(app).post(`/api/keys/${made.body.key.id}/rotate`));
      expect(replaced.status).toBe(201);
      const newId = replaced.body.key.id;
      list = await h(request(app).get('/api/keys'));
      const newKey = list.body.items.find((k: { id: string }) => k.id === newId);
      expect(newKey.webhook).toMatchObject({ url: 'https://example.test/hooks/moved', secretHint: fresh.body.secret.slice(-4) });

      // Taking the address away only takes it away: the key falls back to the organisation's.
      const gone = await h(request(app).delete(`/api/keys/${newId}/webhook`));
      expect(gone.status).toBe(204);
      list = await h(request(app).get('/api/keys'));
      expect(list.body.items.find((k: { id: string }) => k.id === newId).webhook).toBeNull();

      // A key nobody has is refused rather than given an address of its own.
      const nobody = await h(request(app).put('/api/keys/11111111-1111-4111-8111-111111111111/webhook')).send({ url: 'https://example.test/hooks/x' });
      expect(nobody.status).toBe(404);
    } finally { await close(); }
  }, 60_000);
});
