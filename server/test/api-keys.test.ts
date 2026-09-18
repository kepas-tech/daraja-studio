import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner } from './helpers.js';

/**
 * Round 3, phase E: API keys.
 *
 * A key is shown once, stored hashed, carries a role's own permissions, and can never do anything
 * that needs a person's password. Nothing about it reaches a log or an audit row but its prefix.
 */
const { app, deps, close } = makeApp();
afterAll(close);

interface Made { key: { id: string; name: string; prefix: string; role: string; lastUsedAt: string | null; revokedAt: string | null }; secret: string }

describe('API keys', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const make = async (name = 'Payroll script', role = 'viewer'): Promise<Made> => {
    const r = await h(request(app).post('/api/keys')).send({ name, role });
    expect(r.status).toBe(201);
    return r.body as Made;
  };

  it('shows the secret once, and never again', async () => {
    const made = await make();
    expect(made.secret).toMatch(/^studio_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(made.key.prefix).toBe(made.secret.split('_')[1]);

    // The list carries the prefix and the facts, and nothing else about the secret.
    const list = await h(request(app).get('/api/keys'));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ name: 'Payroll script', role: 'viewer', prefix: made.key.prefix, revokedAt: null });
    expect(JSON.stringify(list.body)).not.toContain(made.secret.split('_')[2]);

    // Stored hashed: the row holds no plaintext, and the audit row carries the prefix alone.
    const [row] = await deps.db.query<{ key_hash: string; prefix: string }>('SELECT key_hash, prefix FROM api_keys');
    expect(row!.prefix).toBe(made.key.prefix);
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.key_hash).not.toContain(made.secret.split('_')[2]!);
    const audit = await deps.db.query<{ after_json: unknown }>(`SELECT after_json FROM audit_log WHERE action='api_key.created' AND target=$1`, [made.key.id]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.after_json)).not.toContain(made.secret.split('_')[2]!);
  });

  it('reads with the key, and is refused the things that need a person', async () => {
    const made = await make('Reporting', 'viewer');
    const key = { Authorization: `Bearer ${made.secret}` };

    const read = await request(app).get('/api/requests?limit=1').set(key);
    expect(read.status).toBe(200);
    // A viewer key may not send: the role's preset has no send.phone.
    expect((await request(app).post('/api/send/phone').set(key).send({ phone: '0700123456', amountCents: 100 })).status).toBe(403);
    // And it may not step up, which is what money-moving routes ask for beyond a permission: the
    // viewer role may look up a payment, so the route is reached and the password step refuses it.
    const checked = await request(app).post('/api/requests/00000000-0000-4000-8000-0000000000ff/checked').set(key).send({ note: 'x' });
    expect(checked.status).toBe(403);
    expect(checked.body.error.code).toBe('step_up_required');

    // A role that does carry send.phone still cannot get a payment out: the route asks for a
    // person's password (and a money-ready studio before that), and a key has neither. The proof
    // that matters is that no request row is written.
    const op = await make('Ops', 'operator');
    const sent = await request(app).post('/api/send/phone').set({ Authorization: `Bearer ${op.secret}` }).send({ phone: '0700123456', amountCents: 100 });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
  });

  it('records when a key was last used, at most once a minute', async () => {
    const made = await make('Reporting', 'viewer');
    expect(made.key.lastUsedAt).toBeNull();
    await request(app).get('/api/requests?limit=1').set({ Authorization: `Bearer ${made.secret}` });
    const [row] = await deps.db.query<{ last_used_at: Date | null }>('SELECT last_used_at FROM api_keys WHERE id=$1', [made.key.id]);
    expect(row!.last_used_at).toBeTruthy();
    const first = row!.last_used_at!.getTime();
    await request(app).get('/api/requests?limit=1').set({ Authorization: `Bearer ${made.secret}` });
    const [again] = await deps.db.query<{ last_used_at: Date }>('SELECT last_used_at FROM api_keys WHERE id=$1', [made.key.id]);
    expect(again!.last_used_at.getTime()).toBe(first);
  });

  it('rotating issues a new secret and stops the old one in the same breath', async () => {
    const first = await make('Payroll script', 'operator');
    const rotated = await h(request(app).post(`/api/keys/${first.key.id}/rotate`)).send({});
    expect(rotated.status).toBe(201);
    expect(rotated.body.secret).not.toBe(first.secret);
    expect(rotated.body.key.rotatedFrom).toBe(first.key.id);

    // The old key is refused from here on; the new one works.
    expect((await request(app).get('/api/requests?limit=1').set({ Authorization: `Bearer ${first.secret}` })).status).toBe(401);
    expect((await request(app).get('/api/requests?limit=1').set({ Authorization: `Bearer ${rotated.body.secret}` })).status).toBe(200);
    // Both rows are in the list, the old one marked revoked.
    const list = await h(request(app).get('/api/keys'));
    expect(list.body.items.map((k: { prefix: string; revokedAt: string | null }) => [k.prefix, Boolean(k.revokedAt)])).toEqual([
      [rotated.body.key.prefix, false],
      [first.key.prefix, true],
    ]);
  });

  it('revoking stops a key, and a revoked key cannot be rotated', async () => {
    const made = await make('Old script');
    const killed = await h(request(app).post(`/api/keys/${made.key.id}/revoke`)).send({});
    expect(killed.status).toBe(200);
    expect(killed.body.revokedAt).toBeTruthy();
    expect((await request(app).get('/api/requests?limit=1').set({ Authorization: `Bearer ${made.secret}` })).status).toBe(401);
    const again = await h(request(app).post(`/api/keys/${made.key.id}/rotate`)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('revoked');
  });

  it('a key can never manage keys, and rubbish is refused without a query', async () => {
    const made = await make('Payroll script');
    const key = { Authorization: `Bearer ${made.secret}` };
    expect((await request(app).get('/api/keys').set(key)).status).toBe(403);
    expect((await request(app).post('/api/keys').set(key).send({ name: 'Mine', role: 'approver' })).status).toBe(403);
    expect((await request(app).get('/api/requests').set({ Authorization: 'Bearer not-a-key' })).status).toBe(401);
    expect((await request(app).get('/api/requests').set({ Authorization: `Bearer studio_000000000000_${'x'.repeat(43)}` })).status).toBe(401);
  });
});
