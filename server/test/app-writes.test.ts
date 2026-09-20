import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { ROLE_PRESETS } from '../src/permissions/roles.js';
import { KEY_ROLES } from '../src/keys/service.js';
import { createWebhookWriter } from '../src/webhooks/writer.js';
import { KEY_MAX, REPLAY_HEADER } from '../src/http/idempotency.js';

const push = vi.fn(async () => ({ merchantRequestId: 'MR_1', checkoutRequestId: 'ws_CO_1', responseCode: '0', responseDescription: 'Success', customerMessage: 'ok' }));
const { app, deps, close } = makeApp({
  daraja: {
    get: async () => ({ collect: { stkPush: push } }) as never,
    getForOperator: async () => { throw new Error('an STK push must never need an initiator operator'); },
    invalidate: () => {},
    stkEnabled: async () => true,
  },
});
afterAll(async () => { await deps.events.stop(); await close(); });

const BODY = { phone: '0700123456', amountCents: 100, accountReference: 'INV-7' };
const requestCount = async () => (await deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM requests'))[0]!.n;

/**
 * What a machine calling this studio needs: its own reference on a payment, a key that makes a retry
 * safe, and Safaricom's own name for the payment back. None of it names a caller: they are the three
 * things any integration wants, and the last test here is the whole point — an API key, with no
 * person anywhere, asking for a payment and reading it back.
 */
describe('what an app needs that Studio did not answer', () => {
  let auth: { cookie: string; csrf: string };
  beforeEach(async () => {
    auth = await loginAsOwner(app, deps);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    push.mockClear();
  });
  const ask = (body: unknown, headers: Record<string, string> = {}) =>
    request(app).post('/api/collect/stk').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).set(headers).send(body);

  it('carries the caller\'s own reference, keeps it out of the account reference, and hands it back in the webhook', async () => {
    const r = await ask({ ...BODY, callerRef: 'order-12345' });
    expect(r.status).toBe(201);
    expect(r.body.callerRef).toBe('order-12345');
    // The reference the payer sees is still the business's own, and nothing of the caller's went near
    // it: on a payment request it is the remarks and the Daraja payload, and the row's own
    // account_reference stays empty until a payer's number arrives with the money.
    expect(r.body.remarks).toBe('INV-7');
    expect(r.body.accountReference).toBeNull();

    const [row] = await deps.db.query<{ caller_ref: string | null; account_reference: string | null }>(
      'SELECT caller_ref, account_reference FROM requests');
    expect(row).toMatchObject({ caller_ref: 'order-12345', account_reference: null });

    // What a receiver would actually be posted, through the real writer.
    const seen: Record<string, unknown>[] = [];
    const writer = createWebhookWriter({
      db: deps.db,
      events: deps.events,
      webhooks: { enqueue: async (_event: string, payload: Record<string, unknown>) => { seen.push(payload); return { id: 'delivery-1' }; } } as never,
    });
    await writer.handle({ type: 'request.updated', orgId: deps.db.getFallbackOrg(), payload: { id: r.body.id } } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: 'request.sent', id: r.body.id, callerRef: 'order-12345',
      checkoutRequestId: 'ws_CO_1', remarks: 'INV-7',
    });
  });

  it('takes 64 characters of reference and refuses 65, making nothing on the refusal', async () => {
    const longest = await ask({ ...BODY, callerRef: 'x'.repeat(64) });
    expect(longest.status).toBe(201);
    expect(longest.body.callerRef).toBe('x'.repeat(64));

    const tooLong = await ask({ ...BODY, callerRef: 'x'.repeat(65) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.message).toContain('callerRef');
    expect(tooLong.body.error.message).toContain('64');

    // Nothing was asked of Safaricom and nothing was written.
    expect(push).toHaveBeenCalledTimes(1);
    expect(await requestCount()).toBe('1');
  });

  it('answers a retry with the same key with the first answer, and never a second payment', async () => {
    const first = await ask(BODY, { 'Idempotency-Key': 'app-key-1' });
    expect(first.status).toBe(201);

    const second = await ask(BODY, { 'Idempotency-Key': 'app-key-1' });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers[REPLAY_HEADER.toLowerCase()]).toBe('true');

    // One payment, one request, one call to Safaricom — that is the whole promise.
    expect(push).toHaveBeenCalledTimes(1);
    expect(await requestCount()).toBe('1');

    // A different key is a different request — and the body has to differ too, because Studio's own
    // duplicate guard still refuses the same phone and amount inside five minutes whatever the key.
    expect((await ask({ ...BODY, amountCents: 200 }, { 'Idempotency-Key': 'app-key-2' })).status).toBe(201);
    expect(push).toHaveBeenCalledTimes(2);
    expect(await requestCount()).toBe('2');
  });

  it('refuses a key longer than the ceiling rather than shortening it', async () => {
    const long = await ask(BODY, { 'Idempotency-Key': 'k'.repeat(KEY_MAX + 1) });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('invalid_key');
    expect(push).not.toHaveBeenCalled();
    expect(await requestCount()).toBe('0');
  });

  it('refuses a second call while the first is still running, and takes over one that was abandoned', async () => {
    // A claim with no answer yet: the first call is in flight somewhere.
    await deps.db.query(`INSERT INTO idempotency_keys(scope, key) VALUES ('POST /api/collect/stk', 'busy')`);
    const busy = await ask(BODY, { 'Idempotency-Key': 'busy' });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('idempotency_in_progress');
    expect(push).not.toHaveBeenCalled();
    expect(await requestCount()).toBe('0');

    // The same claim, a minute and more old, is the process that died: the key is taken over rather
    // than held for a day.
    await deps.db.query(`UPDATE idempotency_keys SET created_at = now() - interval '5 minutes' WHERE key = 'busy'`);
    expect((await ask(BODY, { 'Idempotency-Key': 'busy' })).status).toBe(201);
    expect(push).toHaveBeenCalledTimes(1);
    expect(await requestCount()).toBe('1');
  });

  it('lets an API key ask for a payment and read it back with no person involved, end to end', async () => {
    // The key a product is given: the `collector` role, which carries asking for a payment and
    // reading one back and nothing else. This is the whole path such a key takes, against the fake
    // Safaricom — the real one is asked by the owner, not by a test.
    const made = await request(app).post('/api/keys')
      .set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
      .send({ name: 'A product calling in', role: 'collector' });
    expect(made.status).toBe(201);
    const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${made.body.secret}`);

    // No cookie, no CSRF token, no person: the key alone.
    const asked = await bearer(request(app).post('/api/collect/stk')).send({ ...BODY, callerRef: 'app-ref-1' });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ callerRef: 'app-ref-1', checkoutRequestId: 'ws_CO_1', remarks: 'INV-7' });

    // The row says a machine made it: no person, and the key named instead.
    const [row] = await deps.db.query<{ created_by: string | null; api_key_id: string | null }>(
      'SELECT created_by, api_key_id FROM requests');
    expect(row!.created_by).toBeNull();
    expect(row!.api_key_id).toBe(made.body.key.id);

    // And the same key reads it back, with the caller's reference and Safaricom's own name on it.
    const read = await bearer(request(app).get(`/api/requests/${asked.body.id}`));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id: asked.body.id, type: 'stk', callerRef: 'app-ref-1', checkoutRequestId: 'ws_CO_1', remarks: 'INV-7',
    });
  });

  it('gives the operator role the right to ask a customer to pay, which is what lets a key do it', () => {
    // No role an API key could hold carried `stk.request` before this, so every key was refused by the
    // payment route. `operator` now carries it too, and `collector` is the one made for a system:
    // exactly the two permissions an integration needs and nothing else.
    expect(ROLE_PRESETS.operator).toContain('stk.request');
    expect([...ROLE_PRESETS.collector].sort()).toEqual(['lookup.view', 'stk.request']);
    expect(ROLE_PRESETS.viewer).not.toContain('stk.request');
    expect(ROLE_PRESETS.approver).not.toContain('stk.request');
    expect(ROLE_PRESETS.forwarder).not.toContain('stk.request');
    expect(KEY_ROLES).toContain('collector');
  });
});
