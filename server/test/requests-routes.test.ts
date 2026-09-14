import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import { hashPassword } from '../src/auth/password.js';
import type { DarajaFactory } from '../src/sdk/client.js';

const send = async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_R', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'ok' });
const transaction = async () => ({ conversationId: 'AG_Q', originatorConversationId: `q-${Date.now()}`, responseCode: '0', responseDescription: 'ok' });
const daraja: DarajaFactory = { get: async () => ({}) as never, getForOperator: async () => ({ b2c: { send }, status: { transaction }, config: { initiator: 'KEPAS' } }) as never, invalidate: () => {}, stkEnabled: async () => false };
const { app, deps, close } = makeApp({ daraja });
afterAll(close);

/** Returns the seeded operator's id, so a test can assert a sent request picked it. */
async function ready(): Promise<string> {
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS',$1,'verified') RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
  return op.id;
}

describe('POST /api/send/phone', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });

  it('guards in order: login, csrf, money-ready, step-up', async () => {
    expect((await request(app).post('/api/send/phone').send({})).status).toBe(401);
    expect((await request(app).post('/api/send/phone').set('Cookie', cookie).send({})).status).toBe(403);
    let r = await request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf).send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment', password: 'correct horse' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('public_url_unverified');
    await ready();
    r = await request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf).send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('step_up_required');
  });

  it('sends and returns the request view; GET /api/requests/:id reads it back', async () => {
    const operatorId = await ready();
    const r = await request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf).send({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment', remarks: 'rent', password: 'correct horse' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('sent');
    expect(r.body.recipient.value).toBe('254700123456');
    expect(r.body.createdBy.displayName).toBe('Owner');
    const [row] = await deps.db.query<{ operator_id: string }>('SELECT operator_id FROM requests WHERE id=$1', [r.body.id]);
    expect(row.operator_id).toBe(operatorId);
    const g = await request(app).get(`/api/requests/${r.body.id}`).set('Cookie', cookie);
    expect(g.status).toBe(200);
    expect(g.body.id).toBe(r.body.id);
    expect(g.body.currency).toBe('KES');
    expect((await request(app).get('/api/requests/00000000-0000-0000-0000-000000000000').set('Cookie', cookie)).status).toBe(404);
  });

  it('rejects a malformed id with 404 rather than reaching Postgres', async () => {
    const r = await request(app).get('/api/requests/------------------------------------').set('Cookie', cookie);
    expect(r.status).toBe(404);
  });

  it('validates the body in plain English', async () => {
    await ready();
    const r = await request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf).send({ phone: '0700123456', amountCents: 150, commandId: 'BusinessPayment', password: 'correct horse' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('whole_shillings');
    expect(r.body.error.message).toBe('Safaricom sends whole shillings to phones. Remove the cents.');
  });
});

describe('GET /api/requests', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); });

  async function seedRows() {
    const [p] = await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE username='owner'`);
    const rows = [
      ['b2c', 'BusinessPayment', 'oc-1', 'completed', 100, '254700123456', 'RI1', '2026-09-01T10:00:00Z'],
      ['b2c', 'SalaryPayment', 'oc-2', 'failed', 200, '254700000001', null, '2026-09-02T10:00:00Z'],
      ['b2c', 'BusinessPayment', 'oc-3', 'sent', 300, '254700123456', null, '2026-09-03T10:00:00Z'],
      ['status_query', 'sweep', 'oc-4', 'completed', null, null, null, '2026-09-03T11:00:00Z'],
      ['status_query', 'lookup', 'oc-5', 'completed', 250, 'RI9', 'RI9', '2026-09-03T12:00:00Z'],
      ['balance', 'operator_probe', 'oc-6', 'completed', null, null, null, '2026-09-03T13:00:00Z'],
      ['status_query', 'manual', 'oc-7', 'completed', null, null, null, '2026-09-03T14:00:00Z'],
    ];
    for (const [type, subtype, oc, status, amount, value, receipt, at] of rows) {
      await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, receipt, created_by, created_at) VALUES ($1,$2,$3,$4,$5,'phone',$6,$7,$8,$9)`,
        [type, subtype, oc, status, amount, value, receipt, p.id, at]);
    }
  }

  it('defaults to money types, newest first, excludes sweep queries and probes', async () => {
    await seedRows();
    const r = await request(app).get('/api/requests').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { subtype: string }) => i.subtype)).toEqual(['BusinessPayment', 'SalaryPayment', 'BusinessPayment']);
    expect(r.body.items[0].createdAt).toBe('2026-09-03T10:00:00.000Z');
    expect(r.body.nextCursor).toBeNull();
  });

  it('filters by status, date range and free text; lists lookups by type', async () => {
    await seedRows();
    let r = await request(app).get('/api/requests?status=failed').set('Cookie', cookie);
    expect(r.body.items).toHaveLength(1);
    r = await request(app).get('/api/requests?from=2026-09-02&to=2026-09-02').set('Cookie', cookie);
    expect(r.body.items.map((i: { subtype: string }) => i.subtype)).toEqual(['SalaryPayment']);
    r = await request(app).get('/api/requests?q=RI1').set('Cookie', cookie);
    expect(r.body.items).toHaveLength(1);
    r = await request(app).get('/api/requests?q=254700000001').set('Cookie', cookie);
    expect(r.body.items).toHaveLength(1);
    // W1: searching by the phone number as studio displays it (or as an operator would type it
    // off the card) must find the two 254700123456 rows, not just the raw stored digits.
    r = await request(app).get('/api/requests?q=0700123456').set('Cookie', cookie);
    expect(r.body.items).toHaveLength(2);
    r = await request(app).get(`/api/requests?q=${encodeURIComponent('0700 123 456')}`).set('Cookie', cookie);
    expect(r.body.items).toHaveLength(2);
    r = await request(app).get(`/api/requests?q=${encodeURIComponent('+254700123456')}`).set('Cookie', cookie);
    expect(r.body.items).toHaveLength(2);
    r = await request(app).get('/api/requests?q=700123456').set('Cookie', cookie);
    expect(r.body.items).toHaveLength(2);
    r = await request(app).get('/api/requests?type=status_query').set('Cookie', cookie);
    expect(r.body.items.map((i: { subtype: string }) => i.subtype)).toEqual(['lookup']);
    expect(r.body.items.some((i: { subtype: string }) => i.subtype === 'manual')).toBe(false);
  });

  it('pages with an opaque cursor', async () => {
    await seedRows();
    const p1 = await request(app).get('/api/requests?limit=2').set('Cookie', cookie);
    expect(p1.body.items).toHaveLength(2);
    expect(typeof p1.body.nextCursor).toBe('string');
    const p2 = await request(app).get(`/api/requests?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`).set('Cookie', cookie);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.items[0].subtype).toBe('BusinessPayment');
    expect(p2.body.nextCursor).toBeNull();
    expect((await request(app).get('/api/requests?limit=500').set('Cookie', cookie)).status).toBe(400);
  });

  it('marks an unknown request as checked with a note (step-up), refuses otherwise', async () => {
    const [row] = await deps.db.query<{ id: string }>(`INSERT INTO requests(type, originator_conversation_id, status, sent_at) VALUES ('b2c','oc-u','unknown',now()) RETURNING id`);
    let r = await request(app).post(`/api/requests/${row.id}/checked`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ note: 'Paid, seen in portal' });
    expect(r.status).toBe(403);
    r = await request(app).post(`/api/requests/${row.id}/checked`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ note: 'Paid, seen in portal', password: 'correct horse' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('unknown');
    expect(r.body.checked.note).toBe('Paid, seen in portal');
    expect(r.body.checked.by.displayName).toBe('Owner');
    const audit = await deps.db.query(`SELECT 1 FROM audit_log WHERE action='request.checked' AND target=$1`, [row.id]);
    expect(audit).toHaveLength(1);
    // W4: once checked, studio is no longer going to check it itself — the card must stop
    // promising "Do not send it again yet. Studio is checking…", which contradicts what
    // markChecked just told the operator.
    expect(r.body.whatToDo).toBeNull();
    await deps.db.query(`UPDATE requests SET status='completed', result_source='callback' WHERE id=$1`, [row.id]);
    r = await request(app).post(`/api/requests/${row.id}/checked`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ note: 'x', password: 'correct horse' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_unknown');
  });

  it('POST /:id/check runs a manual status query and answers 202 with the query id', async () => {
    const [row] = await deps.db.query<{ id: string }>(`INSERT INTO requests(type, originator_conversation_id, status, sent_at) VALUES ('b2c','oc-chk','sent',now()) RETURNING id`);
    const r = await request(app).post(`/api/requests/${row.id}/check`).set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(202);
    expect(typeof r.body.requestId).toBe('string');
    const [q] = await deps.db.query<{ type: string; payload_json: { targetRequestId: string } }>('SELECT type, payload_json FROM requests WHERE id=$1', [r.body.requestId]);
    expect(q.type).toBe('status_query');
    expect(q.payload_json.targetRequestId).toBe(row.id);
  });

  it('rejects hostile cursors with 400 bad_cursor before touching Postgres', async () => {
    const notBase64url = 'not-base64url-at-all!!!';
    const noPipe = Buffer.from('no-pipe-here').toString('base64url');
    const dashesId = Buffer.from('2026-09-06T10:00:00.123456Z|------------------------------------').toString('base64url');
    for (const cursor of [notBase64url, noPipe, dashesId]) {
      const r = await request(app).get('/api/requests').query({ cursor }).set('Cookie', cookie);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('bad_cursor');
    }
  });

  it('rejects a calendar-invalid date and a to-before-from range with 400 (F2, N1)', async () => {
    for (const q of [{ from: '2026-02-30' }, { from: '2026-13-45' }, { to: '2026-09-32' }, { from: '2026-00-10' }]) {
      const r = await request(app).get('/api/requests').query(q).set('Cookie', cookie);
      expect(r.status).toBe(400);
    }
    const r = await request(app).get('/api/requests').query({ from: '2026-09-05', to: '2026-09-01' }).set('Cookie', cookie);
    expect(r.status).toBe(400);
  });

  it('pages across rows created microseconds apart without skipping or repeating', async () => {
    const [p] = await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE username='owner'`);
    const stamps = ['2026-09-03T10:00:00.123100Z', '2026-09-03T10:00:00.123200Z', '2026-09-03T10:00:00.123300Z'];
    const ids: string[] = [];
    for (const [i, at] of stamps.entries()) {
      const [row] = await deps.db.query<{ id: string }>(
        `INSERT INTO requests(type, subtype, originator_conversation_id, status, created_by, created_at) VALUES ('b2c','BusinessPayment',$1,'sent',$2,$3) RETURNING id`,
        [`oc-us-${i}`, p.id, at]);
      ids.push(row.id);
    }
    const p1 = await request(app).get('/api/requests?limit=2').set('Cookie', cookie);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await request(app).get(`/api/requests?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`).set('Cookie', cookie);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    const seen = [...p1.body.items, ...p2.body.items].map((i: { id: string }) => i.id);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('POST /:id/check requires send.phone, not just lookup.view', async () => {
    await deps.db.query(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('staff','Staff',$1,false)`, [await hashPassword('staff password!!')]);
    const [staff] = await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE username='staff'`);
    await deps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'lookup.view')`, [staff.id]);
    const login = await request(app).post('/api/auth/login').send({ username: 'staff', password: 'staff password!!' });
    const staffCookie = login.headers['set-cookie'][0] as string;
    const [row] = await deps.db.query<{ id: string }>(`INSERT INTO requests(type, originator_conversation_id, status, sent_at) VALUES ('b2c','oc-perm','sent',now()) RETURNING id`);
    const r = await request(app).post(`/api/requests/${row.id}/check`).set('Cookie', staffCookie).set('x-csrf-token', login.body.csrf).send({});
    expect(r.status).toBe(403);
  });

  it('POST /:id/check refuses a repeat within two minutes', async () => {
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, originator_conversation_id, status, sent_at, last_poll_at) VALUES ('b2c','oc-cool','sent',now(),now() - interval '30 seconds') RETURNING id`);
    const r = await request(app).post(`/api/requests/${row.id}/check`).set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('poll_too_soon');
  });

  it('q wildcards are escaped: an underscore does not match every row', async () => {
    await seedRows();
    const r = await request(app).get('/api/requests').query({ q: '_' }).set('Cookie', cookie);
    expect(r.body.items).toHaveLength(0);
  });

  it('day bounds are Nairobi days, not UTC days', async () => {
    const [p] = await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE username='owner'`);
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, created_by, created_at) VALUES ('b2c','BusinessPayment','oc-eat','sent',$1,'2026-09-02T22:30:00Z')`, [p.id]);
    let r = await request(app).get('/api/requests').query({ from: '2026-09-03', to: '2026-09-03' }).set('Cookie', cookie);
    expect(r.body.items.map((i: { subtype: string }) => i.subtype)).toContain('BusinessPayment');
    r = await request(app).get('/api/requests').query({ from: '2026-09-02', to: '2026-09-02' }).set('Cookie', cookie);
    expect(r.body.items.map((i: { subtype: string }) => i.subtype)).not.toContain('BusinessPayment');
  });

  it('markChecked refuses a non-money-type unknown row', async () => {
    const [row] = await deps.db.query<{ id: string }>(`INSERT INTO requests(type, originator_conversation_id, status, sent_at) VALUES ('status_query','oc-sq','unknown',now()) RETURNING id`);
    const r = await request(app).post(`/api/requests/${row.id}/checked`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ note: 'x', password: 'correct horse' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('not_unknown');
  });

  it('re-marking an already-checked row keeps the previous note as the audit before', async () => {
    const [row] = await deps.db.query<{ id: string }>(`INSERT INTO requests(type, originator_conversation_id, status, sent_at) VALUES ('b2c','oc-remark','unknown',now()) RETURNING id`);
    await request(app).post(`/api/requests/${row.id}/checked`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ note: 'first note', password: 'correct horse' });
    await request(app).post(`/api/requests/${row.id}/checked`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ note: 'second note', password: 'correct horse' });
    const [audit] = await deps.db.query<{ before_json: { note: string | null } }>(
      `SELECT before_json FROM audit_log WHERE action='request.checked' AND target=$1 ORDER BY id DESC LIMIT 1`, [row.id]);
    expect(audit.before_json.note).toBe('first note');
  });
});
