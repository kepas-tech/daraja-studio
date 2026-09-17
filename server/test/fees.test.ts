import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { makeApp, resetTables, makePerson, loginAs, TEST_ORG_ID } from './helpers.js';
import { createEventHub } from '../src/events/hub.js';
import { createMoneyOutService } from '../src/money_out/service.js';
import { recordC2b } from '../src/money_in/record.js';
import { createFeesService, DEFAULT_BANDS } from '../src/fees/service.js';
import { encrypt } from '../src/crypto/secrets.js';
import { hashPassword } from '../src/auth/password.js';
import type { DarajaFactory } from '../src/sdk/client.js';

const { app, deps, close } = makeApp();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(close);

const MIGRATION = new URL('../migrations/028_safaricom_fees.sql', import.meta.url);
const ACTOR = { personId: '', ip: '1.1.1.1' };
const OWNER = { cookie: '', csrf: '' };

/** Safaricom itself is never called: the fake ack below is the whole of it. */
function factory(send: (input: unknown) => Promise<unknown>): DarajaFactory {
  return {
    get: async () => ({ b2c: { send } }) as never,
    getForOperator: async () => ({ b2c: { send }, config: { initiator: 'APIONE' } }) as never,
    invalidate: () => {},
    stkEnabled: async () => false,
  } as unknown as DarajaFactory;
}
const ack = vi.fn(async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_1', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));

/** The same call the send review makes. */
const chargeOf = (kind: string, amountCents: number) => createFeesService({ db: deps.db }).chargeFor(kind as 'c2b' | 'b2c' | 'b2b', amountCents);

const bands = (kind: 'c2b' | 'b2c' | 'b2b') => deps.db.query<{ min_cents: string; max_cents: string; charge_cents: string }>(
  'SELECT min_cents, max_cents, charge_cents FROM safaricom_fees WHERE kind = $1 ORDER BY min_cents', [kind]);

describe('fees: the bands', () => {
  beforeEach(async () => {
    const owner = await loginAsOwnerRow();
    OWNER.cookie = owner.cookie; OWNER.csrf = owner.csrf;
    // resetTables does not clear this table (it is not in its list), so each test starts from the
    // seed the service puts back on the first read.
    await deps.db.query('DELETE FROM safaricom_fees');
    await deps.db.query('DELETE FROM requests');
  });

  it('seeds 17 whole-shilling bands per kind, in cents, with no gaps and the published charges', async () => {
    const items = await createFeesService({ db: deps.db }).list();
    expect(items).toHaveLength(51);
    for (const kind of ['c2b', 'b2c', 'b2b'] as const) {
      const rows = items.filter((b) => b.kind === kind);
      expect(rows).toHaveLength(17);
      expect(rows.map((b) => ({ minCents: b.minCents, maxCents: b.maxCents, chargeCents: b.chargeCents }))).toEqual(DEFAULT_BANDS[kind].map((b) => ({ ...b })));
      // No gaps: the next band starts one shilling after the last one ends.
      for (let i = 1; i < rows.length; i++) expect(rows[i].minCents).toBe(rows[i - 1].maxCents + 100);
      for (const b of rows) {
        expect(b.chargeCents % 100).toBe(0);
        expect(b.minCents % 100).toBe(0);
        expect(b.maxCents % 100).toBe(0);
      }
    }
    // The published charges at their boundaries, straight from the design note: C2B 5/10 at KES
    // 101/501, B2C 13/23 at KES 501/1,001.
    expect(items.filter((b) => b.kind === 'c2b').map((b) => b.chargeCents)).toEqual([0, 0, 500, 1000, 1500, 2000, 2500, 3400, 4500, 5500, 7000, 9000, 10000, 12000, 15000, 18000, 25000]);
    expect(items.filter((b) => b.kind === 'b2c').map((b) => b.chargeCents)).toEqual([0, 0, 700, 1300, 2300, 3300, 5600, 5700, 7000, 9000, 11000, 13000, 15000, 17500, 20000, 25000, 33000]);
  });

  it('the migration carries exactly the same bands as the service seeds for a new organisation', async () => {
    // Two copies of the numbers exist on purpose (a SQL seed for the organisations that existed
    // when the migration ran, a TypeScript seed for the ones created after). This is the guard
    // that keeps them one tariff.
    const sql = await readFile(MIGRATION, 'utf8');
    const found: Record<string, { minCents: number; maxCents: number; chargeCents: number }[]> = { c2b: [], b2c: [], b2b: [] };
    for (const m of sql.matchAll(/^\s*\('(c2b|b2c|b2b)', (\d+), (\d+), (\d+)\),?$/gm)) {
      found[m[1]].push({ minCents: Number(m[2]), maxCents: Number(m[3]), chargeCents: Number(m[4]) });
    }
    expect(Object.values(found).flat()).toHaveLength(51);
    for (const kind of ['c2b', 'b2c', 'b2b'] as const) expect(found[kind]).toEqual(DEFAULT_BANDS[kind].map((b) => ({ ...b })));
  });

  it('chargeFor answers the band containing the amount, and nothing above the top band', async () => {
    // KES 100, 101, 500, 501 — the boundaries the design names.
    expect(await chargeOf('c2b', 10000)).toBe(0);
    expect(await chargeOf('c2b', 10100)).toBe(500);
    expect(await chargeOf('c2b', 50000)).toBe(500);
    expect(await chargeOf('c2b', 50100)).toBe(1000);
    // KES 49/50 and KES 150,000: the last band's own edge, then nothing.
    expect(await chargeOf('c2b', 4900)).toBe(0);
    expect(await chargeOf('c2b', 5000)).toBe(0);
    expect(await chargeOf('c2b', 15000000)).toBe(25000);
    expect(await chargeOf('c2b', 15000100)).toBeNull();
    // B2C: KES 501 is 13, KES 1,001 is 23, KES 5,000 is 57.
    expect(await chargeOf('b2c', 50100)).toBe(1300);
    expect(await chargeOf('b2c', 100100)).toBe(2300);
    expect(await chargeOf('b2c', 500000)).toBe(5700);
    // An amount under the first band, and a nonsense one, are both "no band".
    expect(await chargeOf('b2c', 50)).toBeNull();
    expect(await chargeOf('b2c', 0)).toBeNull();
  });
});

describe('fees: stored on the row', () => {
  beforeEach(async () => {
    const owner = await loginAsOwnerRow();
    OWNER.cookie = owner.cookie; OWNER.csrf = owner.csrf;
    await deps.db.query('DELETE FROM safaricom_fees');
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    // A verified operator, so the send path finds one. The SDK itself is the fake below.
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
    ack.mockClear();
  });

  it('a send keeps the B2C charge its band said, and shows it in the view', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 50100, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.chargeCents).toBe(1300);
    const [row] = await deps.db.query<{ charge_cents: string }>('SELECT charge_cents FROM requests WHERE id=$1', [v.id]);
    expect(row.charge_cents).toBe('1300');
  });

  it('a C2B payment keeps the C2B charge its band said', async () => {
    const r = await recordC2b(deps, {
      transactionType: 'Pay Bill', transId: 'RKT1234567', transTime: '20260916101530', amount: 250, shortCode: '600999', billRefNumber: '000123',
      invoiceNumber: '', orgAccountBalance: 1000, thirdPartyTransId: '', msisdn: '254700123456', firstName: 'Jane', middleName: '', lastName: 'Doe',
    }, 'callback');
    const [row] = await deps.db.query<{ charge_cents: string }>('SELECT charge_cents FROM requests WHERE id=$1', [r.requestId]);
    expect(row.charge_cents).toBe('500'); // KES 250 falls in the 101–500 band: C2B charge KES 5.
  });

  it('an amount above the top band stores nothing, never a zero that would read as free', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const v = await svc.send({ phone: '0700123456', amountCents: 20000000, commandId: 'BusinessPayment' }, ACTOR);
    expect(v.chargeCents).toBeNull();
    const [row] = await deps.db.query<{ charge_cents: string | null }>('SELECT charge_cents FROM requests WHERE id=$1', [v.id]);
    expect(row.charge_cents).toBeNull();
  });

  it('a later tariff change does not rewrite an old row, and does price the next one', async () => {
    const svc = createMoneyOutService({ ...deps, daraja: factory(ack), events });
    const first = await svc.send({ phone: '0700123456', amountCents: 10000, commandId: 'BusinessPayment' }, ACTOR);
    expect(first.chargeCents).toBe(0);
    // The owner corrects the B2C tariff: one band, KES 1 to KES 1,000, charge KES 99.
    const put = await request(app).put('/api/fees/b2c').set('Cookie', OWNER.cookie).set('x-csrf-token', OWNER.csrf)
      .send({ bands: [{ minCents: 100, maxCents: 100000, chargeCents: 9900 }], password: 'correct horse' });
    expect(put.status).toBe(200);
    const after = await request(app).get(`/api/requests/${first.id}`).set('Cookie', OWNER.cookie);
    expect(after.body.chargeCents).toBe(0);
    const second = await svc.send({ phone: '0700123456', amountCents: 20000, commandId: 'BusinessPayment' }, ACTOR);
    expect(second.chargeCents).toBe(9900);
  });
});

describe('fees: the owner corrects a band', () => {
  beforeEach(async () => {
    const owner = await loginAsOwnerRow();
    OWNER.cookie = owner.cookie; OWNER.csrf = owner.csrf;
    await deps.db.query('DELETE FROM safaricom_fees');
    // The three kinds seeded, so "the others were left alone" is a real comparison.
    await createFeesService({ db: deps.db }).list();
  });

  const put = (kind: string, body: unknown) => request(app).put(`/api/fees/${kind}`).set('Cookie', OWNER.cookie).set('x-csrf-token', OWNER.csrf).send(body as object);

  it('replaces one kind whole, keeps the others, and writes one audit row', async () => {
    const before = await deps.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action='fees.updated' AND target='b2c'`);
    const r = await put('b2c', { bands: [{ minCents: 100, maxCents: 50000, chargeCents: 700 }, { minCents: 50100, maxCents: 15000000, chargeCents: 5000 }], password: 'correct horse' });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0]).toMatchObject({ kind: 'b2c', minCents: 100, maxCents: 50000, chargeCents: 700 });
    expect(await bands('b2c')).toHaveLength(2);
    expect(await bands('c2b')).toHaveLength(17); // untouched
    const after = await deps.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action='fees.updated' AND target='b2c'`);
    expect(Number(after[0].n) - Number(before[0].n)).toBe(1);
  });

  it('refuses overlapping bands in plain English, and keeps the bands it had', async () => {
    const r = await put('c2b', { bands: [{ minCents: 100, maxCents: 50000, chargeCents: 500 }, { minCents: 40000, maxCents: 90000, chargeCents: 900 }], password: 'correct horse' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_bands');
    expect(String(r.body.error.message)).toContain('same amount');
    expect(await bands('c2b')).toHaveLength(17);
  });

  it('refuses cents, an empty list, and a band that ends before it starts', async () => {
    expect((await put('c2b', { bands: [{ minCents: 150, maxCents: 50000, chargeCents: 500 }], password: 'correct horse' })).status).toBe(400);
    expect((await put('c2b', { bands: [], password: 'correct horse' })).status).toBe(400);
    expect((await put('c2b', { bands: [{ minCents: 50000, maxCents: 100, chargeCents: 500 }], password: 'correct horse' })).status).toBe(400);
    expect(await bands('c2b')).toHaveLength(17);
  });

  it('needs the owner and the password', async () => {
    expect((await put('c2b', { bands: [{ minCents: 100, maxCents: 50000, chargeCents: 500 }] })).status).toBe(403); // no password
    expect((await put('c2b', { bands: [{ minCents: 100, maxCents: 50000, chargeCents: 500 }], password: 'wrong' })).status).toBe(403);
    await makePerson(deps.db, TEST_ORG_ID, { username: 'operator1', password: 'operator password', role: 'operator' });
    const operator = await loginAs(app, 'operator1', 'operator password');
    const r = await request(app).put('/api/fees/c2b').set('Cookie', operator.cookie).set('x-csrf-token', operator.csrf)
      .send({ bands: [{ minCents: 100, maxCents: 50000, chargeCents: 500 }], password: 'operator password' });
    expect(r.status).toBe(403);
    expect(await bands('c2b')).toHaveLength(17);
  });

  it('reads back over the API for the send review, and needs lookup.view', async () => {
    const r = await request(app).get('/api/fees/charge?kind=b2c&amountCents=50100').set('Cookie', OWNER.cookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ chargeCents: 1300 });
    const all = await request(app).get('/api/fees').set('Cookie', OWNER.cookie);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(51);
  });

  it('a second boot leaves the owner\'s bands exactly as they are', async () => {
    const put1 = await put('b2b', { bands: [{ minCents: 100, maxCents: 100000, chargeCents: 1000 }], password: 'correct horse' });
    expect(put1.status).toBe(200);
    // Run the migration's own seed again, the way a boot would if the file were ever replayed: the
    // NOT EXISTS guard must see this organisation already has bands.
    const sql = await readFile(MIGRATION, 'utf8');
    await deps.db.query(sql.slice(sql.lastIndexOf('DO $$')));
    const rows = await bands('b2b');
    expect(rows).toHaveLength(1);
    expect(rows[0].charge_cents).toBe('1000');
  });
});

/** loginAsOwner, but the owner row is created here so the fees tests can then delete fee rows. */
async function loginAsOwnerRow(): Promise<{ cookie: string; csrf: string }> {
  await resetTables(deps.db);
  const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner',$1,true) RETURNING id`, [await hashPassword('correct horse')]);
  ACTOR.personId = p.id;
  const r = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
  return { cookie: r.headers['set-cookie'][0] as string, csrf: r.body.csrf as string };
}
