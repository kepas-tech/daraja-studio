import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { C2bPayment } from '@kepas/daraja-js';
import { makeApp, loginAsOwner } from './helpers.js';
import { recordC2b } from '../src/money_in/record.js';
import { candidates, normalizeName } from '../src/routing/claims.js';

/**
 * Migration 052: named account numbers on a shared paybill. A name is one account across every
 * business on the paybill, case does not matter, a taken name comes with free suggestions, and a
 * payment to the name reaches the account. Real PostgreSQL.
 */
const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });

describe('named account numbers', () => {
  let auth: { cookie: string; csrf: string };
  let sinro = ''; let kepas = ''; let sinroCode = '';
  const h = (r: request.Test) => r.set('Cookie', auth.cookie).set('x-csrf-token', auth.csrf);
  const as = (secret: string) => ({ Authorization: `Bearer ${secret}` });
  const key = async (businessId: string) => (await h(request(app).post('/api/keys')).send({ name: 'app ' + Math.random(), role: 'collector', businessId })).body.secret as string;
  const account = async (k: string, ref: string) => (await request(app).put('/api/accounts/by-ref/' + ref).set(as(k)).send({ name: ref })).body as { id: string; fullNumber: string; namedNumber: string | null };

  beforeEach(async () => {
    auth = await loginAsOwner(app, deps);
    kepas = (await h(request(app).post('/api/businesses')).send({ name: 'KEPAS' })).body.id;
    const s = (await h(request(app).post('/api/businesses')).send({ name: 'SINRO' })).body;
    sinro = s.id; sinroCode = s.code;
  });

  it('reads names without case, and refuses what can never be a name', () => {
    expect(normalizeName(' john ')).toBe('JOHN');
    expect(normalizeName('jo')).toBeNull();
    expect(normalizeName('12345')).toBeNull();
    expect(normalizeName('JOHN-DOE')).toBeNull();
    expect(normalizeName('ABCDEFGHIJKLM')).toBeNull();
    for (const c of candidates('ABCDEFGHIJKL')) expect(normalizeName(c)).toBe(c);
  });

  it('an app\'s user takes a name, and a payment to it, in any case, reaches their account', async () => {
    const k = await key(sinro);
    const a = await account(k, 'user-1');
    expect((await request(app).get('/api/accounts/name-check?name=john').set(as(k))).body).toMatchObject({ name: 'JOHN', available: true });
    const named = await request(app).put('/api/accounts/by-ref/user-1/name').set(as(k)).send({ name: 'john' });
    expect(named.status).toBe(200);
    expect(named.body).toEqual({ name: 'JOHN' });
    expect((await account(k, 'user-1')).namedNumber).toBe('JOHN');
    const out = await recordC2b({ db: deps.db, events: deps.events }, {
      transactionType: 'Pay Bill', transId: 'UIO0000101', transTime: '20260925101742', amount: 50, shortCode: '600999', billRefNumber: 'John',
      invoiceNumber: '', orgAccountBalance: '', thirdPartyTransId: '', msisdn: '254700123456', firstName: 'JOHN', middleName: '', lastName: '',
    } as unknown as C2bPayment, 'callback', { silent: true });
    const [row] = await deps.db.query<{ business_id: string; account_id: string }>(`SELECT business_id, account_id FROM requests WHERE id=$1`, [out.requestId]);
    expect(row).toEqual({ business_id: sinro, account_id: a.id });
    // The digits still work beside the name.
    expect(a.fullNumber.startsWith(sinroCode)).toBe(true);
  });

  it('a name is one account across the whole paybill; a taken name comes with free suggestions', async () => {
    const a = await account(await key(sinro), 'user-1');
    const kk = await key(kepas);
    await account(kk, 'user-2');
    await h(request(app).put(`/api/accounts/${a.id}/name`)).send({ name: 'MARY' });
    const check = (await request(app).get('/api/accounts/name-check?name=mary').set(as(kk))).body;
    expect(check).toMatchObject({ available: false, reason: 'taken' });
    expect(check.suggestions.length).toBeGreaterThanOrEqual(3);
    for (const s of check.suggestions as string[]) expect(s).toMatch(/^(\d{1,3}MARY|MARY\d{1,3})$/);
    const refused = await request(app).put('/api/accounts/by-ref/user-2/name').set(as(kk)).send({ name: 'Mary' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'name_taken', details: { reason: 'taken' } });
    const pick = refused.body.error.details.suggestions[0] as string;
    expect((await request(app).put('/api/accounts/by-ref/user-2/name').set(as(kk)).send({ name: pick })).status).toBe(200);
  });

  it('a name may not start like an app\'s payments or a business code, nor equal an alias', async () => {
    const [enabo] = await deps.db.query<{ id: string }>(`INSERT INTO apps(key, name, business_id) VALUES ('enabo', 'enabo', $1) RETURNING id`, [kepas]);
    await deps.db.query(`INSERT INTO route_claims(token, kind, app_id) VALUES ('ENABO', 'prefix', $1)`, [enabo!.id]);
    await deps.db.query(`INSERT INTO route_claims(token, kind, business_id) VALUES ('KEPAS', 'alias', $1)`, [kepas]);
    const k = await key(sinro);
    const reason = async (name: string) => (await request(app).get('/api/accounts/name-check?name=' + name).set(as(k))).body.reason;
    expect(await reason('ENABOX')).toBe('starts_with_prefix');
    expect(await reason('kepas')).toBe('taken');
    expect(await reason(sinroCode + 'A')).toBe('starts_with_code');
    expect(await reason('KEPASA')).toBeNull();
    // A prefix that would be the start of a word already claimed is refused by the database itself.
    await expect(deps.db.query(`INSERT INTO route_claims(token, kind, app_id) VALUES ('KEP', 'prefix', $1)`, [enabo!.id])).rejects.toThrow(/covers_claim/);
    // And a business code under a prefix cannot be given out.
    await deps.db.query(`INSERT INTO route_claims(token, kind, app_id) VALUES ('7', 'prefix', $1)`, [enabo!.id]);
    const b = await h(request(app).post('/api/businesses')).send({ name: 'Seven' });
    expect(b.body.code.startsWith('7')).toBe(false);
    await expect(deps.businesses.create('Taken', 'other', { personId: null, ip: 'test' }, '712')).rejects.toMatchObject({ code: 'code_taken' });
  });

  it('a released name is kept from others for a while, but its own account may take it back', async () => {
    const k = await key(sinro);
    const a = await account(k, 'user-1');
    await account(k, 'user-2');
    await request(app).put('/api/accounts/by-ref/user-1/name').set(as(k)).send({ name: 'PETER' });
    await request(app).put('/api/accounts/by-ref/user-1/name').set(as(k)).send({ name: 'PETE' });
    expect((await account(k, 'user-1')).namedNumber).toBe('PETE');
    const other = await request(app).put('/api/accounts/by-ref/user-2/name').set(as(k)).send({ name: 'PETER' });
    expect(other.body.error?.details?.reason).toBe('held');
    expect((await request(app).put(`/api/accounts/${a.id}/name`).set('Cookie', auth.cookie).set('x-csrf-token', auth.csrf).send({ name: 'peter' })).status).toBe(200);
    expect((await request(app).delete('/api/accounts/by-ref/user-1/name').set(as(k))).status).toBe(204);
    expect((await account(k, 'user-1')).namedNumber).toBeNull();
    const audit = await deps.db.query<{ action: string }>(`SELECT action FROM audit_log WHERE target=$1 AND action LIKE 'account.name%' ORDER BY id`, [a.id]);
    expect(audit.map((x) => x.action)).toEqual(['account.named', 'account.named', 'account.named', 'account.name_released']);
  });

  it('ten accounts choosing one name at once: one gets it, nine are told and offered others', async () => {
    const k = await key(sinro);
    for (let i = 0; i < 10; i++) await account(k, 'u' + i);
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => request(app).put(`/api/accounts/by-ref/u${i}/name`).set(as(k)).send({ name: 'GRACE' })));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    const refused = all.filter((r) => r.status === 409);
    expect(refused).toHaveLength(9);
    for (const r of refused) expect(r.body.error.details.suggestions.length).toBeGreaterThan(0);
    expect((await deps.db.query(`SELECT 1 FROM route_claims WHERE token='GRACE' AND released_at IS NULL`)).length).toBe(1);
  });
});
