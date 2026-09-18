import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, makePerson, loginAs, TEST_ORG_ID } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Round 3, phase D-3: recent checks on History.
 *
 * Every check Studio makes with Safaricom is already a `status_query` row — a person pressing
 * Check on a payment, a receipt looked up, the sweep's own polls — written so the answer can be
 * matched when it comes back. Nothing listed them; `GET /api/requests/checks` does.
 */
const transaction = vi.fn(async () => ({ conversationId: 'AG_S', originatorConversationId: `st-${Math.random().toString(36).slice(2)}`, responseCode: '0', responseDescription: 'ok' }));
const send = vi.fn(async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_1', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'ok' }));
const daraja: DarajaFactory = {
  get: async () => ({}) as never,
  getForOperator: async () => ({ b2c: { send }, status: { transaction }, config: { initiator: 'APIONE' } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
};
const { app, deps, close } = makeApp({ daraja });
afterAll(close);

async function ready() {
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status, rotated_at) VALUES ('APIONE',$1,'verified', now() - interval '84 days')`, [encrypt(deps.config.secretKey, 'c')]);
}

describe('recent checks on History', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); transaction.mockClear(); await ready(); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const list = (qs = '') => h(request(app).get(`/api/requests/checks${qs}`));

  it('lists a check on a payment with the payment it was about', async () => {
    const sent = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, commandId: 'BusinessPayment', password: 'correct horse' });
    expect(sent.status).toBe(201);
    const checked = await h(request(app).post(`/api/requests/${sent.body.id}/check`)).send({});
    expect(checked.status).toBe(202);

    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({
      id: checked.body.requestId,
      kind: 'manual',
      status: 'sent',
      target: { requestId: sent.body.id, receipt: null, number: '254700123456' },
      askedBy: { displayName: 'Owner' },
    });
    // The check is not money and is not in the payments list.
    const history = await h(request(app).get('/api/requests?limit=50'));
    expect(history.body.items.map((x: { id: string }) => x.id)).toEqual([sent.body.id]);
  });

  it('lists a receipt lookup by its receipt, with no payment behind it', async () => {
    const asked = await h(request(app).post('/api/lookup')).send({ receipt: 'ri6bztpxnm' });
    expect(asked.status).toBe(202);
    const r = await list();
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ kind: 'lookup', target: { requestId: null, receipt: 'RI6BZTPXNM', name: null, number: null } });
  });

  it('newest first, only real checks, and the limit is honoured', async () => {
    await deps.db.query(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, recipient_value, created_at) VALUES
        ('status_query','sweep','oc-1','completed','RI6BZTPXNM', now() - interval '3 hours'),
        ('status_query','manual','oc-2','failed','254700123456', now() - interval '2 hours'),
        ('status_query','lookup','oc-3','sent','RI6BZTPXNN', now() - interval '1 hour'),
        ('balance','operator_probe','oc-4','sent',NULL, now()),
        ('status_query','probe','oc-5','sent',NULL, now())`);
    const all = await list('?limit=20');
    expect(all.body.items.map((c: { kind: string }) => c.kind)).toEqual(['lookup', 'manual', 'sweep']);
    expect(all.body.items[1]).toMatchObject({ status: 'failed' });
    const one = await list('?limit=1');
    expect(one.body.items.map((c: { kind: string }) => c.kind)).toEqual(['lookup']);
    const bad = await list('?limit=99');
    expect(bad.status).toBe(400);
  });

  it('needs a session and the read permission', async () => {
    const anonymous = await request(app).get('/api/requests/checks');
    expect(anonymous.status).toBe(401);
    await makePerson(deps.db, TEST_ORG_ID, { username: 'nobody', password: 'correct horse', role: 'custom' });
    const p = await loginAs(app, 'nobody', 'correct horse');
    const refused = await request(app).get('/api/requests/checks').set('Cookie', p.cookie).set('x-csrf-token', p.csrf);
    expect(refused.status).toBe(403);
  });
});
