import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';

const send = async (input: { originatorConversationId: string; commandId: string }) => { lastCommand = input.commandId; return { conversationId: 'AG_R', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'ok' }; };
let lastCommand = '';
const daraja: DarajaFactory = { get: async () => ({}) as never, getForOperator: async () => ({ b2c: { send }, status: { transaction: async () => ({ conversationId: 'q', originatorConversationId: 'q', responseCode: '0', responseDescription: 'ok' }) }, config: { initiator: 'KEPAS' } }) as never, invalidate: () => {}, stkEnabled: async () => false };
const { app, deps, close } = makeApp({ daraja });
afterAll(close);

async function ready() {
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS',$1,'verified')`, [encrypt(deps.config.secretKey, 'c')]);
}

describe('payment categories', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });
  const put = (items: unknown, password = 'correct horse') => request(app).put('/api/settings/send-categories').set('Cookie', cookie).set('x-csrf-token', csrf).send({ items, password });

  it('starts with the three Safaricom kinds and lists them to any logged-in person', async () => {
    const r = await request(app).get('/api/send/categories').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(r.status).toBe(200);
    expect(r.body.items.map((c: { name: string }) => c.name)).toEqual(['Business payment', 'Salary', 'Promotion']);
    const v = await request(app).get('/api/settings').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(v.body.sendCategories).toHaveLength(3);
  });

  it('the owner replaces the list; names must be unique; the list may not be empty', async () => {
    let r = await put([{ name: 'Personal use', commandId: 'BusinessPayment' }, { name: 'Salary', commandId: 'SalaryPayment' }]);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([{ id: 'personal-use', name: 'Personal use', commandId: 'BusinessPayment' }, { id: 'salary', name: 'Salary', commandId: 'SalaryPayment' }]);
    r = await put([{ name: 'Rent', commandId: 'BusinessPayment' }, { name: 'rent', commandId: 'SalaryPayment' }]);
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('category_duplicate');
    r = await put([]);
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('categories_empty');
    r = await put([{ name: 'Odd', commandId: 'SomethingElse' }]);
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('category_kind');
    r = await put([{ name: 'Rent', commandId: 'BusinessPayment' }], 'wrong');
    expect(r.status).toBe(403);
  });

  it('a send with a category stores the name and sends its Safaricom command; an unknown one is refused', async () => {
    await ready();
    await put([{ name: 'Personal use', commandId: 'PromotionPayment' }]);
    let r = await request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf).send({ phone: '0700123456', amountCents: 100, category: 'personal USE', password: 'correct horse' });
    expect(r.status).toBe(201);
    expect(r.body.category).toBe('Personal use');
    expect(r.body.subtype).toBe('PromotionPayment');
    expect(lastCommand).toBe('PromotionPayment');
    r = await request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf).send({ phone: '0700123457', amountCents: 100, category: 'Gone', password: 'correct horse' });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('unknown_category');
    // Deleting the category afterwards leaves the old request readable with its name.
    await put([{ name: 'Rent', commandId: 'BusinessPayment' }]);
    const list = await request(app).get('/api/requests').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(list.body.items[0].category).toBe('Personal use');
  });
});
