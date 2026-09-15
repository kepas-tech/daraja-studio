import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createEventHub } from '../src/events/hub.js';
import { createMoneyOutService, APPROVAL_EXPIRED } from '../src/money_out/service.js';
import { testDeps, resetTables, makeApp, loginAsOwner } from './helpers.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { encrypt } from '../src/crypto/secrets.js';
import { hashPassword } from '../src/auth/password.js';

const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(() => deps.db.end());

const MAKER = { personId: '', ip: '1.1.1.1' };
const APPROVER = { personId: '', ip: '1.1.1.2' };

function factory(send: (input: unknown) => Promise<unknown>): DarajaFactory {
  return {
    get: async () => ({ b2c: { send } }) as never,
    getForOperator: async () => ({ b2c: { send }, config: { initiator: 'KEPAS' } }) as never,
    invalidate: () => {},
    stkEnabled: async () => false,
  } as unknown as DarajaFactory;
}
const ack = vi.fn(async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_1', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
const INPUT = { phone: '0700123456', amountCents: 500000, commandId: 'BusinessPayment' as const };

describe('waiting for approval (service)', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.settings.set('send.approvalThresholdCents', '500000');
    const [m] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
    MAKER.personId = m.id;
    const [a] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner, role) VALUES ('anna','Anna','x',false,'approver') RETURNING id`);
    APPROVER.personId = a.id;
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('KEPAS',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
    ack.mockClear();
  });

  it('below the threshold sends at once; at the threshold it waits and nothing is sent', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const small = await svc.send({ ...INPUT, amountCents: 499900 }, MAKER);
    expect(small.status).toBe('sent');
    expect(ack).toHaveBeenCalledTimes(1);
    const held = await svc.send(INPUT, MAKER);
    expect(held.status).toBe('awaiting_approval');
    expect(ack).toHaveBeenCalledTimes(1);
    const [row] = await deps.db.query<{ operator_id: string | null; approved_by: string | null }>('SELECT operator_id, approved_by FROM requests WHERE id=$1', [held.id]);
    expect(row).toEqual({ operator_id: null, approved_by: null });
    expect((await svc.listAwaiting()).items.map((r) => r.id)).toEqual([held.id]);
  });

  it('a second person releases it down the ordinary path, once, and the maker cannot', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const held = await svc.send(INPUT, MAKER);
    await expect(svc.release(held.id, MAKER)).rejects.toMatchObject({ status: 403, code: 'own_request' });
    const released = await svc.release(held.id, APPROVER);
    expect(released.status).toBe('sent');
    expect(released.approvedBy?.id).toBe(APPROVER.personId);
    expect(ack).toHaveBeenCalledTimes(1);
    await expect(svc.release(held.id, APPROVER)).rejects.toMatchObject({ status: 409, code: 'not_held' });
    expect(ack).toHaveBeenCalledTimes(1);
    const [row] = await deps.db.query<{ operator_id: string | null }>('SELECT operator_id FROM requests WHERE id=$1', [held.id]);
    expect(row.operator_id).not.toBeNull();
  });

  it('refusing records who and why; the maker cannot refuse their own', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const held = await svc.send(INPUT, MAKER);
    await expect(svc.refuse(held.id, 'Wrong supplier', MAKER)).rejects.toMatchObject({ status: 403 });
    const refused = await svc.refuse(held.id, 'Wrong supplier', APPROVER);
    expect(refused.status).toBe('rejected');
    expect(refused.meaning).toBe('Wrong supplier');
    expect(refused.approvedBy?.displayName).toBe('Anna');
    expect(ack).not.toHaveBeenCalled();
    await expect(svc.release(held.id, APPROVER)).rejects.toMatchObject({ status: 409 });
  });

  it('the clock refuses a held send after 24 hours and leaves younger ones alone', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const old = await svc.send(INPUT, MAKER);
    const young = await svc.send({ ...INPUT, amountCents: 600000 }, MAKER);
    await deps.db.query(`UPDATE requests SET created_at = now() - interval '25 hours' WHERE id=$1`, [old.id]);
    expect(await svc.expireApprovals()).toBe(1);
    const rows = await deps.db.query<{ id: string; status: string; meaning: string | null }>('SELECT id, status, meaning FROM requests ORDER BY amount_cents');
    expect(rows.find((r) => r.id === old.id)).toMatchObject({ status: 'rejected', meaning: APPROVAL_EXPIRED });
    expect(rows.find((r) => r.id === young.id)?.status).toBe('awaiting_approval');
  });

  it('changing the threshold does not touch a row already held', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const held = await svc.send(INPUT, MAKER);
    await deps.settings.set('send.approvalThresholdCents', '0');
    expect((await svc.listAwaiting()).items.map((r) => r.id)).toEqual([held.id]);
    const free = await svc.send({ ...INPUT, amountCents: 700000 }, MAKER);
    expect(free.status).toBe('sent');
  });
});

describe('waiting for approval (routes)', () => {
  const { app, deps: adeps, close } = makeApp({ daraja: factory(ack) });
  afterAll(close);
  let owner: { cookie: string; csrf: string };
  let anna: { cookie: string; csrf: string };
  beforeEach(async () => {
    owner = await loginAsOwner(app, adeps);
    await adeps.settings.set('public.url', 'https://studio.example');
    await adeps.settings.set('public.verifiedAt', new Date().toISOString());
    await adeps.settings.set('env.sandbox.consumerKey', 'k');
    await adeps.settings.set('env.sandbox.consumerSecret', 's');
    await adeps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
    await adeps.settings.set('env.sandbox.shortcode', '600999');
    await adeps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('KEPAS',$1,'verified',1)`, [encrypt(adeps.config.secretKey, 'c')]);
    const [a] = await adeps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner, role) VALUES ('anna','Anna',$1,false,'approver') RETURNING id`, [await hashPassword('correct horse')]);
    await adeps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'send.approve')`, [a.id]);
    const login = await request(app).post('/api/auth/login').send({ username: 'anna', password: 'correct horse' });
    anna = { cookie: login.headers['set-cookie'][0] as string, csrf: login.body.csrf as string };
    ack.mockClear();
  });
  const as = (s: { cookie: string; csrf: string }) => (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

  it('the owner sets the threshold; a send at it is held; the approver sees it, the count shows it, and releases it with a password', async () => {
    expect((await as(owner)(request(app).put('/api/settings/approval-threshold')).send({ cents: 500000, password: 'correct horse' })).status).toBe(204);
    expect((await request(app).get('/api/settings').set('Cookie', owner.cookie)).body.approvalThresholdCents).toBe(500000);
    const sent = await as(owner)(request(app).post('/api/send/phone')).send({ ...INPUT, password: 'correct horse' });
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('awaiting_approval');
    expect((await request(app).get('/api/approvals/count').set('Cookie', owner.cookie)).body.count).toBe(1);
    expect((await request(app).get('/api/approvals').set('Cookie', anna.cookie)).body.items.length).toBe(1);
    // The maker, even as owner, cannot release their own.
    expect((await as(owner)(request(app).post(`/api/approvals/${sent.body.id}/release`)).send({ password: 'correct horse' })).status).toBe(403);
    expect((await as(anna)(request(app).post(`/api/approvals/${sent.body.id}/release`)).send({})).status).toBe(403);
    const rel = await as(anna)(request(app).post(`/api/approvals/${sent.body.id}/release`)).send({ password: 'correct horse' });
    expect(rel.status).toBe(201);
    expect(rel.body.status).toBe('sent');
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('refuse needs a reason and a person with the permission', async () => {
    await adeps.settings.set('send.approvalThresholdCents', '1');
    const sent = await as(owner)(request(app).post('/api/send/phone')).send({ ...INPUT, amountCents: 100, password: 'correct horse' });
    expect(sent.body.status).toBe('awaiting_approval');
    expect((await as(anna)(request(app).post(`/api/approvals/${sent.body.id}/refuse`)).send({ reason: '' })).status).toBe(400);
    const r = await as(anna)(request(app).post(`/api/approvals/${sent.body.id}/refuse`)).send({ reason: 'Not this week' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('rejected');
    await adeps.db.query(`DELETE FROM permissions WHERE permission='send.approve'`);
    expect((await request(app).get('/api/approvals').set('Cookie', anna.cookie)).status).toBe(403);
  });
});
