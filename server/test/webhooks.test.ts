import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { testDeps, resetTables, makeApp, loginAsOwner, makePerson, loginAs, TEST_ORG_ID } from './helpers.js';
import { createWebhooksService } from '../src/webhooks/service.js';
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

  it('refuses an address that points inside the network, and never retries it', async () => {
    const w = service();
    await w.save('https://example.test/hooks/studio', actor);
    // Written straight into the table: save refuses this, and the dispatcher must too, whatever
    // put the row there.
    const [made] = await deps.db.query<{ id: string }>(
      `INSERT INTO webhook_deliveries(event, url, payload) VALUES ('request.failed','https://10.1.2.3/hook','{}'::jsonb) RETURNING id`);
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
      `INSERT INTO webhook_deliveries(event, url, payload) VALUES ('request.completed','https://example.test/hooks/studio','{}'::jsonb) RETURNING id`);

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

  it('is the owner alone, over the routes', async () => {
    const { app, deps: appDeps, close } = makeApp();
    try {
      const s = await loginAsOwner(app, appDeps);
      const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
      const saved = await h(request(app).put('/api/webhooks')).send({ url: 'https://example.test/hooks/studio' });
      expect(saved.status).toBe(200);
      expect(saved.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await h(request(app).get('/api/webhooks'))).body.webhook).toMatchObject({ url: 'https://example.test/hooks/studio' });

      await makePerson(appDeps.db, TEST_ORG_ID, { username: 'staff', password: 'correct horse', role: 'operator' });
      const staff = await loginAs(app, 'staff', 'correct horse');
      const refused = await request(app).get('/api/webhooks').set('Cookie', staff.cookie);
      expect(refused.status).toBe(403);
    } finally { await close(); }
  });
});
