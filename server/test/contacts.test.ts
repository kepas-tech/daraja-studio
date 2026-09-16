import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, loginAs, makePerson, resetTables, seedOrg, deleteOrg, TEST_ORG_ID } from './helpers.js';
import { createAdminPool, withOrg } from '../src/db/pool.js';
import { encrypt } from '../src/crypto/secrets.js';
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

describe('contacts', () => {
  let s: { cookie: string; csrf: string };
  beforeEach(async () => {
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
    ack.mockClear();
  });
  const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
  const add = (body: Record<string, unknown>) => h(request(app).post('/api/contacts')).send(body);
  const phone = (over: Record<string, unknown> = {}) => add({ kind: 'phone', name: 'Mama Njeri', phone: '0712 345 678', ...over });
  const sendPhone = (body: Record<string, unknown>) => h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, commandId: 'BusinessPayment', password: 'correct horse', ...body });

  it('the database itself refuses a phone contact with a shortcode and a blank name', async () => {
    await expect(deps.db.query(`INSERT INTO contacts(kind, name, phone, shortcode) VALUES ('phone','Bad shape','254712345678','12345')`)).rejects.toThrow();
    await expect(deps.db.query(`INSERT INTO contacts(kind, name, phone) VALUES ('phone','   ','254712345678')`)).rejects.toThrow();
    await expect(deps.db.query(`INSERT INTO contacts(kind, name, shortcode) VALUES ('till','Shop','123')`)).rejects.toThrow();
  });

  it('creates a phone contact from a written number and lists it normalised', async () => {
    const r = await phone();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'phone', name: 'Mama Njeri', phone: '254712345678', shortcode: null, accountReference: null });
    const list = await request(app).get('/api/contacts').set('Cookie', s.cookie);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].phone).toBe('254712345678');
  });

  it('refuses a duplicate live name, and the name is free again after a soft delete', async () => {
    const first = await phone();
    expect(first.status).toBe(201);
    const dup = await phone({ name: 'mama njeri' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('name_taken');
    expect(dup.body.error.message).toBe('You already have a contact called mama njeri.');
    expect((await h(request(app).delete(`/api/contacts/${first.body.id}`))).status).toBe(204);
    expect((await phone()).status).toBe(201);
  });

  it('filters by kind and by name, and refuses a field that does not belong to the kind', async () => {
    await phone();
    expect((await add({ kind: 'till', name: 'Duka', shortcode: '123456' })).status).toBe(201);
    expect((await add({ kind: 'paybill', name: 'KPLC', shortcode: '888880', accountReference: 'ACC1' })).status).toBe(201);
    const tills = await request(app).get('/api/contacts?kind=till').set('Cookie', s.cookie);
    expect(tills.body.items.map((c: { name: string }) => c.name)).toEqual(['Duka']);
    const searched = await request(app).get('/api/contacts?q=duk').set('Cookie', s.cookie);
    expect(searched.body.items.map((c: { name: string }) => c.name)).toEqual(['Duka']);
    const tillWithPhone = await add({ kind: 'till', name: 'Phone on a till', shortcode: '123456', phone: '0712345678' });
    expect(tillWithPhone.status).toBe(400);
    const badReference = await add({ kind: 'paybill', name: 'Bad account', shortcode: '888880', accountReference: 'ACC-1' });
    expect(badReference.status).toBe(400);
    expect((await request(app).get('/api/contacts').set('Cookie', s.cookie)).body.items).toHaveLength(3);
  });

  it('a person without contacts.manage may read the list but not create, edit or delete', async () => {
    const c = await phone();
    await makePerson(deps.db, TEST_ORG_ID, { username: 'staff', password: 'staff password!!', role: 'operator' });
    const staff = await loginAs(app, 'staff', 'staff password!!');
    const read = await request(app).get('/api/contacts').set('Cookie', staff.cookie);
    expect(read.status).toBe(200);
    expect(read.body.items).toHaveLength(1);
    const create = await request(app).post('/api/contacts').set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf).send({ kind: 'phone', name: 'Not allowed', phone: '0700123457' });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('no_permission');
    const edit = await request(app).put(`/api/contacts/${c.body.id}`).set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf).send({ kind: 'phone', name: 'Renamed', phone: '0712 345 678' });
    expect(edit.status).toBe(403);
    const del = await request(app).delete(`/api/contacts/${c.body.id}`).set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf);
    expect(del.status).toBe(403);
    const list = await request(app).get('/api/contacts').set('Cookie', s.cookie);
    expect(list.body.items[0].name).toBe('Mama Njeri');
  });

  it('edit and soft delete: gone from the list, still on the row it was paid from', async () => {
    const c = await phone();
    const sent = await sendPhone({ phone: '0712 345 678', contactId: c.body.id });
    expect(sent.status).toBe(201);
    const edited = await h(request(app).put(`/api/contacts/${c.body.id}`)).send({ kind: 'phone', name: 'Mama Njeri Shop', phone: '0712 345 678', note: 'Rent' });
    expect(edited.status).toBe(200);
    expect(edited.body.note).toBe('Rent');
    expect((await h(request(app).delete(`/api/contacts/${c.body.id}`))).status).toBe(204);
    expect((await request(app).get('/api/contacts').set('Cookie', s.cookie)).body.items).toHaveLength(0);
    const [row] = await deps.db.query<{ contact_id: string | null }>('SELECT contact_id FROM requests WHERE id=$1', [sent.body.id]);
    expect(row.contact_id).toBe(c.body.id);
    const view = await request(app).get(`/api/requests/${sent.body.id}`).set('Cookie', s.cookie);
    expect(view.body.contactName).toBe('Mama Njeri Shop');
  });

  it('a send that names a matching contact stores it and shows contactName on the request', async () => {
    const c = await phone();
    const r = await sendPhone({ phone: '0712 345 678', contactId: c.body.id });
    expect(r.status).toBe(201);
    expect(r.body.contactName).toBe('Mama Njeri');
    const [row] = await deps.db.query<{ contact_id: string | null }>('SELECT contact_id FROM requests WHERE id=$1', [r.body.id]);
    expect(row.contact_id).toBe(c.body.id);
    const view = await request(app).get(`/api/requests/${r.body.id}`).set('Cookie', s.cookie);
    expect(view.body.contactName).toBe('Mama Njeri');
    expect(view.body.recipient.value).toBe('254712345678');
  });

  it('a send whose number differs from the saved contact is refused and writes no row', async () => {
    const c = await phone();
    const r = await sendPhone({ phone: '0700123457', contactId: c.body.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('contact_mismatch');
    const [count] = await deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM requests');
    expect(count.n).toBe('0');
  });

  it('an unknown contact, another organisation contact, or a till contact is refused', async () => {
    let r = await sendPhone({ contactId: '00000000-0000-4000-8000-0000000000aa' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('unknown_contact');
    const admin = createAdminPool(deps.config.databaseUrl);
    const otherOrg = '00000000-0000-4000-8000-0000000000bb';
    await seedOrg(admin, { id: otherOrg, slug: 'contacts-other', name: 'Other business', secret: 'other-contacts-secret' });
    const [foreign] = await withOrg(otherOrg, () => deps.db.query<{ id: string }>(`INSERT INTO contacts(kind, name, phone) VALUES ('phone','Foreign','254700000009') RETURNING id`));
    r = await sendPhone({ contactId: foreign.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('unknown_contact');
    const till = await add({ kind: 'till', name: 'Duka', shortcode: '123456' });
    r = await sendPhone({ contactId: till.body.id });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('unknown_contact');
    await deleteOrg(otherOrg);
    await admin.end();
  });

  it('bulk send gives a row that matches a live phone contact the same contact_id', async () => {
    const c = await phone();
    const text = '0712 345 678,100,Mama Njeri\n0700123457,200,John';
    const created = await h(request(app).post('/api/send/bulk')).send({ text, password: 'correct horse' });
    expect(created.status).toBe(201);
    await deps.bulk.drain(created.body.id);
    const rows = await deps.db.query<{ recipient_value: string; contact_id: string | null }>(`SELECT recipient_value, contact_id FROM requests WHERE type='b2c' ORDER BY created_at`);
    expect(rows.map((x) => [x.recipient_value, x.contact_id])).toEqual([['254712345678', c.body.id], ['254700123457', null]]);
  });
});
