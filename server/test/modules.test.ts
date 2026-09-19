import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createAdminPool, withSystem } from '../src/db/pool.js';
import { makeApp, loginAs, loginAsOwner, makePerson, deleteOrg, TEST_ORG_ID } from './helpers.js';

/**
 * Step one of the tiers-and-modules design: a modules table per organisation, a tier setting, and
 * one place that answers whether a part of Studio is on. What is tested here is the promise the page
 * makes to the owner — a module off hides and refuses and never deletes, a dependency holds another
 * one on, the tier applies its set and can be departed from, every change is audited, and the whole
 * thing is the owner's alone behind the step-up.
 */
const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });

const PW = 'correct horse';
/** Every part of Studio that exists today, plus the two declared for later and not built. */
const KEYS = ['contacts', 'businesses', 'statements', 'invoices', 'people', 'approvals', 'reports', 'reconcile', 'cases', 'reversals', 'standing_orders', 'express_checkout', 'bonga', 'notifications', 'developer', 'feed', 'scheduled_payments', 'custody'];
/** The parts that are declared and not built: listed, never switchable, with nothing behind them. */
const NOT_BUILT = ['scheduled_payments', 'custody'];
/** The menu keys the web knows about (web/src/copy/en.ts). A module may only claim one of these. */
const NAV_KEYS = ['home', 'notifications', 'history', 'reports', 'stk', 'money-in', 'qr', 'invoices', 'standing-orders', 'express', 'bonga', 'send', 'contacts', 'bulk', 'approvals', 'reverse', 'api-keys', 'webhooks', 'businesses', 'who-did-what', 'settings', 'advanced', 'guide', 'not-possible'];

interface ModuleRow { key: string; name: string; sentence: string; on: boolean; built: boolean; switchable: boolean; changed: boolean; permissions: { key: string; label: string }[]; menu: string[]; hides: string; needs: { key: string; name: string; on: boolean }[]; heldBy: { key: string; name: string }[] }
interface TierRow { key: string; name: string; sentence: string; on: string[]; planned: string[] }
interface View { tier: string; chosen: boolean; matches: string | null; departures: number; tiers: TierRow[]; modules: ModuleRow[]; alsoOn?: string[] }

describe('modules and tiers', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const view = async (): Promise<View> => (await h(request(app).get('/api/modules'))).body as View;
  const one = async (key: string) => (await view()).modules.find((m) => m.key === key)!;
  const set = (key: string, enabled: boolean) => h(request(app).post('/api/modules/' + key)).send({ enabled, password: PW });
  const tier = (key: string) => h(request(app).post('/api/modules/tier')).send({ tier: key, password: PW });

  it('declares every part of Studio that exists today, in the owner’s own words', async () => {
    const v = await view();
    expect(v.modules.map((m) => m.key)).toEqual(KEYS);
    for (const m of v.modules) {
      expect(m.name.length, m.key).toBeGreaterThan(2);
      expect(m.sentence.length, m.key).toBeGreaterThan(20);
      expect(m.hides.length, m.key).toBeGreaterThan(5);
      expect(Array.isArray(m.permissions), m.key).toBe(true);
      expect(Array.isArray(m.menu), m.key).toBe(true);
    }
    // One owner per menu entry, or hiding it for one module would hide it for another's reason.
    const menu = v.modules.flatMap((m) => m.menu);
    expect(new Set(menu).size).toBe(menu.length);
    for (const key of menu) expect(NAV_KEYS).toContain(key);
    // Every permission a module claims is a real one, with the catalogue's own plain label.
    const real = v.modules.flatMap((m) => m.permissions);
    expect(real.length).toBeGreaterThan(0);
    for (const p of real) expect(p.label.length).toBeGreaterThan(3);
    expect(real.find((p) => p.key === 'contacts.manage')!.label).toBe('Can keep the contact list');
    // The three tiers, each a named set.
    expect(v.tiers.map((t) => t.key)).toEqual(['simple', 'business', 'platform']);
    for (const t of v.tiers) expect(t.sentence.length).toBeGreaterThan(20);
  });

  it('keeps every tier closed: a set never turns on a part without what it stands on', async () => {
    const v = await view();
    const byKey = new Map(v.modules.map((m) => [m.key, m]));
    // A need that names a module must be switched on by the same tier; one that names a part of
    // Studio which is always on (money out) has nothing to carry and nothing to enforce.
    const carries = (t: TierRow, m: ModuleRow, label: string) => {
      for (const n of m.needs) if (byKey.has(n.key)) expect(t.on, label + ' stands on ' + n.key).toContain(n.key);
    };
    for (const t of v.tiers) {
      for (const key of t.on) {
        const m = byKey.get(key)!;
        expect(m, t.key + ': ' + key).toBeDefined();
        expect(m.built, t.key + ': ' + key).toBe(true);
        expect(t.planned).not.toContain(key);
        carries(t, m, t.key + ': ' + key);
      }
      // A part a tier has a place for must not be waiting on something that tier leaves off, or
      // switching it on when it is built would be refused.
      for (const key of t.planned) {
        expect(byKey.has(key), t.key + ' plans ' + key).toBe(true);
        expect(t.on, t.key + ' plans ' + key).not.toContain(key);
        carries(t, byKey.get(key)!, t.key + ' plans ' + key);
      }
    }
    // Every dependency a part declares names a part that exists, built or not, or one that is
    // always on.
    for (const m of v.modules) for (const n of m.needs) expect(byKey.has(n.key) || n.on === true, m.key + ' needs ' + n.key).toBe(true);
  });

  it('refuses the routes of a module that is off with 409 module_off, and never 404', async () => {
    expect((await h(request(app).get('/api/invoices'))).status).toBe(200);
    expect((await set('invoices', false)).status).toBe(200);

    const refused = await h(request(app).get('/api/invoices'));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'module_off' });
    expect(refused.body.error.details).toMatchObject({ module: 'invoices' });
    expect(refused.body.error.message).toContain('Invoices');
    // A write into the same module answers the same way, before anything is validated or written.
    expect((await h(request(app).post('/api/invoices')).send({})).status).toBe(409);

    // And the menu stops offering it, for everybody signed in, from the one read the app already makes.
    const me = await h(request(app).get('/api/auth/me'));
    expect(me.body.modules.off).toContain('invoices');
    expect(me.body.modules.menuOff).toContain('invoices');
    // The module is still listed for the owner; off is not gone.
    expect((await one('invoices')).on).toBe(false);
  });

  it('hides and refuses, never deletes: everything is there again when it is on', async () => {
    const made = await h(request(app).post('/api/contacts')).send({ kind: 'phone', name: 'Mama Njeri', phone: '0712345678' });
    expect(made.status).toBe(201);
    expect((await set('contacts', false)).status).toBe(200);
    expect((await h(request(app).get('/api/contacts'))).status).toBe(409);
    // The row itself is untouched, and so is the permission that governs writing one.
    expect(await deps.db.query('SELECT 1 FROM contacts')).toHaveLength(1);

    expect((await set('contacts', true)).status).toBe(200);
    const list = await h(request(app).get('/api/contacts'));
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { name: string }) => c.name)).toContain('Mama Njeri');
  });

  it('will not switch a module off under something that needs it, and names what is holding it', async () => {
    const before = await one('people');
    expect(before.on).toBe(true);
    expect(before.heldBy).toEqual([{ key: 'approvals', name: 'Approvals' }]);

    const refused = await set('people', false);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'module_in_use' });
    expect(refused.body.error.message).toContain('Approvals');
    expect(refused.body.error.details).toMatchObject({ module: 'people' });
    expect((await one('people')).on).toBe(true);

    // With approvals off, people may go off…
    expect((await set('approvals', false)).status).toBe(200);
    expect((await set('people', false)).status).toBe(200);
    // …and turning approvals back on brings people back with it, named in the answer.
    const back = await set('approvals', true);
    expect(back.status).toBe(200);
    expect(back.body.alsoOn).toEqual(['people']);
    expect((await one('people')).on).toBe(true);
    expect((await one('people')).heldBy).toEqual([{ key: 'approvals', name: 'Approvals' }]);
  });

  it('leaves Simple with nothing under Advanced, and refuses each of the three kinds by name', async () => {
    // Simple is a shop or a stall: standing orders, express checkout and Bonga points are all off,
    // so Advanced holds nothing, and each route answers with its own part's name.
    expect((await tier('simple')).status).toBe(200);
    const v = await view();
    expect(v.modules.filter((m) => m.on && m.menu.some((k) => ['standing-orders', 'express', 'bonga'].includes(k)))).toEqual([]);
    const me = await h(request(app).get('/api/auth/me'));
    for (const key of ['standing-orders', 'express', 'bonga']) expect(me.body.modules.menuOff).toContain(key);

    const refusals: [string, string, Record<string, unknown>][] = [
      ['standing_orders', '/api/collect/ratiba', { name: 'Rent', phone: '254700000000', amountCents: 1000, frequency: 'monthly', startDate: '2026-10-01', transactionType: 'paybill' }],
      ['express_checkout', '/api/collect/express', { till: '600999', amountCents: 1000, paymentRef: 'INV1' }],
      ['bonga', '/api/collect/bonga/redeem', { phone: '254700000000', points: 100 }],
    ];
    for (const [key, path, body] of refusals) {
      const refused = await h(request(app).post(path)).send(body);
      expect(refused.status, path).toBe(409);
      expect(refused.body.error.code, path).toBe('module_off');
      expect(refused.body.error.details, path).toMatchObject({ module: key });
      const name = (await one(key)).name;
      expect(refused.body.error.message, path).toContain(name);
    }
    // Asking a customer to pay is not one of the three: it is core. It has its own readiness rule
    // and may refuse for that, but never with the module's own code.
    const stk = await h(request(app).post('/api/collect/stk')).send({});
    expect(stk.body.error?.code).not.toBe('module_off');
  });

  it('applies a tier’s set, and lets a person depart from it', async () => {
    const simple = await tier('simple');
    expect(simple.status).toBe(200);
    expect(simple.body).toMatchObject({ tier: 'simple', matches: 'simple', departures: 0 });
    expect((simple.body as View).modules.filter((m) => m.on && m.built).map((m) => m.key)).toEqual(['contacts', 'notifications']);
    expect((await h(request(app).get('/api/invoices'))).status).toBe(409);

    // A departure: one module back on, with the tier left where it was.
    expect((await set('invoices', true)).status).toBe(200);
    const departed = await view();
    expect(departed).toMatchObject({ tier: 'simple', matches: null, departures: 1 });
    expect(departed.modules.find((m) => m.key === 'invoices')!.changed).toBe(true);
    expect((await h(request(app).get('/api/invoices'))).status).toBe(200);

    // Applying the tier again puts it back to the set it names.
    expect((await tier('simple')).status).toBe(200);
    expect((await h(request(app).get('/api/invoices'))).status).toBe(409);
    expect((await view()).departures).toBe(0);
    // A tier nobody has heard of is refused.
    expect((await tier('enterprise')).status).toBe(400);
  });

  it('previews a tier change without making it', async () => {
    const p = await h(request(app).post('/api/modules/tier/preview')).send({ tier: 'simple' });
    expect(p.status).toBe(200);
    expect(p.body.from).toBe('platform');
    expect(p.body.changes).toEqual(expect.arrayContaining([{ key: 'invoices', name: 'Invoices', from: true, to: false }]));
    expect(p.body.off).toContain('invoices');
    expect(p.body.changes.every((c: { from: boolean; to: boolean }) => c.from !== c.to)).toBe(true);
    // Nothing moved.
    expect((await view()).tier).toBe('platform');
    expect((await h(request(app).get('/api/invoices'))).status).toBe(200);
  });

  it('writes an audit row for every switch and every tier change', async () => {
    // audit_log is append-only and deliberately survives a reset, so this test reads only the rows
    // its own two changes wrote.
    const [from] = await deps.db.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM audit_log');
    await set('invoices', false);
    await tier('simple');
    const rows = await deps.db.query<{ action: string; target: string | null; after_json: Record<string, unknown>; person_id: string | null }>(
      "SELECT action, target, after_json, person_id FROM audit_log WHERE action LIKE 'modules.%' AND id > $1 ORDER BY id", [from!.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['modules.changed', 'modules.tier_set']);
    expect(rows[0]).toMatchObject({ target: 'invoices', after_json: { enabled: false, alsoOn: [] } });
    expect(rows[1]!.after_json).toMatchObject({ tier: 'simple' });
    expect(rows.every((r) => r.person_id !== null)).toBe(true);
  });

  it('is the owner’s alone, and every change asks for the step-up', async () => {
    await makePerson(deps.db, TEST_ORG_ID, { username: 'staff', password: PW, role: 'custom' });
    const staff = await loginAs(app, 'staff', PW);
    const staffRead = await request(app).get('/api/modules').set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf);
    expect(staffRead.status).toBe(403);
    expect(staffRead.body.error.code).toBe('owner_only');
    const staffSet = await request(app).post('/api/modules/invoices').set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf).send({ enabled: false });
    expect(staffSet.status).toBe(403);

    const noPassword = await h(request(app).post('/api/modules/invoices')).send({ enabled: false });
    expect(noPassword.status).toBe(403);
    expect(noPassword.body.error.code).toBe('step_up_required');
    const wrong = await h(request(app).post('/api/modules/invoices')).send({ enabled: false, password: 'nope' });
    expect(wrong.status).toBe(403);
    const wrongTier = await h(request(app).post('/api/modules/tier')).send({ tier: 'simple' });
    expect(wrongTier.status).toBe(403);
    // Refused means nothing moved.
    expect((await one('invoices')).on).toBe(true);
    expect((await set('invoices', false)).status).toBe(200);
  });

  it('lists the two parts that are declared and not built, and refuses to switch either', async () => {
    const v = await view();
    for (const key of NOT_BUILT) {
      const m = await one(key);
      expect(m, key).toMatchObject({ built: false, switchable: false, on: false, changed: false, menu: [], permissions: [] });
      expect(m.sentence.length, key).toBeGreaterThan(20);
      expect(m.heldBy, key).toEqual([]);
      const refused = await set(key, true);
      expect(refused.status, key).toBe(409);
      expect(refused.body.error.code, key).toBe('not_built');
    }
    // Scheduled payments says exactly what it is and what it stands on, and money out is a part of
    // Studio that is always on rather than a module with a switch.
    const scheduled = await one('scheduled_payments');
    expect(scheduled).toMatchObject({ name: 'Scheduled payments', sentence: 'Pay the same people on a timetable.' });
    expect(scheduled.needs).toEqual([{ key: 'money_out', name: 'Money out', on: true }, { key: 'contacts', name: 'Contacts', on: true }]);
    expect(v.modules.find((m) => m.key === 'custody')!.sentence).toContain('balances');

    // A tier has a place for them, or not: Simple has none of it, Business the schedules, Platform
    // both — and none of them is on, because none of them is built.
    const planned = (k: string) => v.tiers.find((t) => t.key === k)!.planned;
    expect(planned('simple')).toEqual([]);
    expect(planned('business')).toEqual(['scheduled_payments']);
    expect(planned('platform')).toEqual(['scheduled_payments', 'custody']);
    for (const t of v.tiers) for (const key of NOT_BUILT) expect(t.on, t.key).not.toContain(key);
  });

  it('starts an organisation that has never chosen on Business, with the developer side off', async () => {
    const ORG_B = '00000000-0000-4000-8000-0000000000b7';
    const admin = createAdminPool(process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test');
    try {
      await withSystem(() => admin.query(
        `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ($1, 'org-b7', 'A second studio', 'verified', false, 'hash-b7', 'enc-b7', gen_random_bytes(32))
         ON CONFLICT (id) DO NOTHING`, [ORG_B]));
      await makePerson(admin, ORG_B, { username: 'boss', password: PW, displayName: 'Boss', isOwner: true, role: 'owner' });
      const boss = await loginAs(app, 'boss', PW);
      const b = (r: request.Test) => r.set('Cookie', boss.cookie).set('x-csrf-token', boss.csrf);
      const v = (await b(request(app).get('/api/modules'))).body as View;
      expect(v).toMatchObject({ tier: 'business', chosen: false, matches: 'business' });
      expect((await b(request(app).get('/api/keys'))).status).toBe(409);
      // The feed is a module too, so its inbox refuses with the module's name even for the owner.
      expect((await b(request(app).post('/api/money-in/feed')).send({})).status).toBe(409);
      // The everyday surface is all there.
      expect((await b(request(app).get('/api/contacts'))).status).toBe(200);
      expect((await b(request(app).get('/api/invoices'))).status).toBe(200);
    } finally { await deleteOrg(ORG_B); await admin.end(); }
  });

  it('stops reading the feed’s own numbers, and refuses the inbox, when the feed is off', async () => {
    const made = await h(request(app).post('/api/keys')).send({ name: 'KEPAS Pay forwarder', role: 'forwarder' });
    expect(made.status).toBe(201);
    const secret = made.body.secret as string;
    const confirmation = { TransactionType: 'Pay Bill', TransID: 'RCMOD0001', TransTime: '20260919121530', TransAmount: '250.00', BusinessShortCode: '600999', BillRefNumber: '000-KEPAS-1', MSISDN: '254712345678', FirstName: 'SAMWEL', MiddleName: 'NGUGI', LastName: 'IRUNGU' };
    expect((await request(app).post('/api/money-in/feed').set('Authorization', 'Bearer ' + secret).send(confirmation)).status).toBe(201);

    const before = await h(request(app).get('/api/money-in/status'));
    expect(before.body.feedKeys).toBe(1);
    expect(before.body.lastFedAt).toBeTruthy();

    expect((await set('feed', false)).status).toBe(200);
    const after = await h(request(app).get('/api/money-in/status'));
    expect(after.body).toMatchObject({ feedKeys: 0, lastFedAt: null });
    // The row itself stays exactly where it was.
    expect(await deps.db.query("SELECT 1 FROM requests WHERE receipt='RCMOD0001'")).toHaveLength(1);

    const refused = await request(app).post('/api/money-in/feed').set('Authorization', 'Bearer ' + secret).send({ ...confirmation, TransID: 'RCMOD0002' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'module_off' });
    expect(refused.body.error.details).toMatchObject({ module: 'feed' });
    expect((await h(request(app).post('/api/money-in/arrival')).send({ arrival: 'studio' })).status).toBe(409);
    // Money in itself — the registration, the missed-payments check, the page — is still there.
    expect((await h(request(app).get('/api/money-in/status'))).status).toBe(200);
    expect((await h(request(app).get('/api/money-in/recent'))).status).toBe(200);
  });
});
