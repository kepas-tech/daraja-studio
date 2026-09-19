import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { encrypt } from '../src/crypto/secrets.js';
import { feeFor, netOf } from '../src/sweep/fee.js';
import { windowFor } from '../src/sweep/window.js';
import type { StudioEvent } from '../src/events/hub.js';

/**
 * Step three of nine: sweep-through. The nine rules the design lists, each one proved against the
 * real rows — and against the fake Safaricom only, because a test never sends money on a live
 * environment.
 *
 * (The file beside this one, sweep.test.ts, is the money-out job that settles results that never
 * arrived. Different thing, older name.)
 */
const SAF_IP = '196.201.214.200';
// eslint-disable-next-line prefer-const -- forward-referenced by the fake's post closure
let app: express.Express;
const fake = createFakeSafaricom({ post: async (path, body) => { await request(app).post(path).set('X-Forwarded-For', SAF_IP).send(body as object); } });
const made = makeApp({ fetchImpl: fake.fetchImpl });
app = made.app;
const { deps, close } = made;
const PW = 'correct horse';
let seen: StudioEvent[] = [];
let unsubscribe: (() => void) | null = null;

beforeAll(async () => { await deps.events.start(); unsubscribe = deps.events.subscribe((e) => { seen.push(e); }); });
afterAll(async () => { unsubscribe?.(); await deps.events.stop(); await close(); });

/** Everything a money send needs: an environment, a tested address, and one verified operator. */
async function ready() {
  await deps.settings.set('env.sandbox.shortcode', '600999');
  await deps.settings.set('daraja.environment', 'sandbox');
  await deps.settings.set('env.sandbox.consumerKey', 'k');
  await deps.settings.set('env.sandbox.consumerSecret', 's');
  await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
}

describe('sweep-through', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => {
    ({ cookie, csrf } = await loginAsOwner(app, deps));
    await ready();
    fake.reset();
    seen = [];
  });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);

  /** One business of the paybill, the way the Businesses page makes one. */
  async function newBusiness(name = 'Kilimani Flats', code = '010'): Promise<string> {
    const [row] = await deps.db.query<{ id: string }>(`INSERT INTO businesses(code, name) VALUES ($1,$2) RETURNING id`, [code, name]);
    return row.id;
  }
  /**
   * A customer pays one of that business's account numbers. Written straight in: the matching
   * itself is proved in money-in-record.test.ts, and what is under test here is what a sweep does
   * with money that has already arrived.
   */
  async function paid(businessId: string, cents: number, receipt: string): Promise<void> {
    await deps.db.query(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, receipt, business_id, sent_at, result_at, result_code, result_desc)
       VALUES ('c2b','Pay Bill',$3,'completed',$2,'KES','phone','254700123456',$4,$1,now(),now(),'0','Completed')`,
      [businessId, cents, 'c2b:' + receipt, receipt]);
  }
  /** What Safaricom last said the Utility account holds, which is what a sweep checks against. */
  async function floatIs(cents: number | null, at = new Date()): Promise<void> {
    await deps.db.query(
      `INSERT INTO balances(working_cents, utility_cents, charges_paid_cents, raw, queried_at) VALUES (0,$1,0,'{}'::jsonb,$2)`,
      [cents, at]);
  }
  const noFee = { percentBp: 0, flatCents: 0, floorCents: null, ceilingCents: null };
  const save = (businessId: string, body: Record<string, unknown> = {}) =>
    h(request(app).post('/api/sweep/' + businessId)).send({ password: PW, destinationPhone: '0712345678', schedule: 'arrival', hour: 20, weekday: 1, fee: noFee, ...body });
  const sweepsOf = async (businessId: string) => (await deps.sweep.one(businessId)).sweeps;
  const b2cRows = async () => deps.db.query<{ id: string; status: string; amount_cents: string; recipient_value: string }>(
    `SELECT id, status, amount_cents, recipient_value FROM requests WHERE type='b2c' ORDER BY created_at, id`);
  const chargeFor = async (cents: number): Promise<number> => {
    const [band] = await deps.db.query<{ charge_cents: string }>(
      `SELECT charge_cents FROM safaricom_fees WHERE kind='b2c' AND $1::bigint BETWEEN min_cents AND max_cents`, [cents]);
    return Number(band.charge_cents);
  };
  /** Wait for an event to come round the hub. The hub is a real LISTEN, so it is not instant. */
  async function alertSeen(match: (e: StudioEvent) => boolean, ms = 2000): Promise<StudioEvent | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = seen.find(match);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('makes one sweep per window, however many passes land on it', async () => {
    const id = await newBusiness();
    expect((await save(id)).status).toBe(200);
    await paid(id, 500000, 'R1');
    await floatIs(5_000_000);
    const first = await deps.sweep.run();
    expect(first).toMatchObject({ businesses: 1, sent: 1, held: 0, failed: 0 });
    // A second pass inside the same window finds the row and stops. This is the whole guard.
    expect((await deps.sweep.run()).sent).toBe(0);
    expect(await sweepsOf(id)).toHaveLength(1);
    expect(await b2cRows()).toHaveLength(1);
    expect((await sweepsOf(id))[0]).toMatchObject({ state: 'sending', destinationPhone: '254712345678' });
    // Safaricom answers, and the sweep takes the receipt the payment row already carries.
    await fake.settle();
    await deps.sweep.run();
    const [row] = await sweepsOf(id);
    expect(row).toMatchObject({ state: 'sent', netCents: 500000 });
    expect(row.receipt).toMatch(/^RI/);
    expect(await b2cRows()).toHaveLength(1);
  });

  it('holds the whole sweep when the float is short, names the gap, sends nothing, and alerts', async () => {
    const id = await newBusiness();
    await save(id);
    await paid(id, 500000, 'R1');
    await floatIs(300000);
    const out = await deps.sweep.run();
    expect(out).toMatchObject({ held: 1, sent: 0, failed: 0, skipped: 0 });
    expect(await b2cRows()).toHaveLength(0);
    const charge = await chargeFor(500000);
    const [row] = await sweepsOf(id);
    expect(row).toMatchObject({ state: 'held', reasonCode: 'float_short', grossCents: 500000, netCents: 500000 });
    expect(row.gapCents).toBe(500000 + charge - 300000);
    expect(row.reason).toContain('short of the float');
    const alert = await alertSeen((e) => e.type === 'alert' && (e.payload as { kind?: string }).kind === 'sweep_held');
    expect(alert).not.toBeNull();
    expect(alert!.payload).toMatchObject({ businessName: 'Kilimani Flats', code: 'float_short', gapCents: 500000 + charge - 300000 });
    // Nothing was sent, the money is still owed, and the page says why.
    const view = await deps.sweep.one(id);
    expect(view.owed.owedCents).toBe(500000);
    expect(view.waiting).toMatchObject({ code: 'float_short', gapCents: 500000 + charge - 300000 });
    // The same hold is not written down again every minute.
    await deps.sweep.run();
    expect(await sweepsOf(id)).toHaveLength(1);
  });

  it('does not attempt less than Safaricom sends, and the money rides into the next window', async () => {
    const id = await newBusiness();
    await save(id);
    await paid(id, 300, 'R1');
    await floatIs(5_000_000);
    const t0 = new Date();
    expect(await deps.sweep.run(t0)).toMatchObject({ skipped: 1, sent: 0, held: 0 });
    expect(await b2cRows()).toHaveLength(0);
    // Not attempted means no row at all: the page works the reason out from the figures.
    expect(await sweepsOf(id)).toHaveLength(0);
    const small = await deps.sweep.one(id);
    expect(small.owed.owedCents).toBe(300);
    expect(small.waiting).toMatchObject({ code: 'below_minimum' });
    expect(small.waiting!.text).toContain('KES 10');
    // More arrives, and the next window takes the lot rather than only the new payment.
    await paid(id, 4700, 'R2');
    expect((await deps.sweep.run(new Date(t0.getTime() + 6 * 60_000))).sent).toBe(1);
    const [row] = await sweepsOf(id);
    expect(row).toMatchObject({ grossCents: 5000, netCents: 5000 });
    expect(row.payments.map((p) => p.receipt)).toEqual(['R1', 'R2']);
  });

  it('works the fee out to the shilling, honours its floor and its ceiling, and records it', async () => {
    const id = await newBusiness();
    const t0 = new Date();
    const twoAndAHalf = { percentBp: 250, flatCents: 1000, floorCents: null, ceilingCents: null };
    await save(id, { fee: twoAndAHalf });
    await paid(id, 100000, 'R1');
    await floatIs(5_000_000);
    await deps.sweep.run(t0);
    expect((await sweepsOf(id))[0]).toMatchObject({ grossCents: 100000, feeCents: 3500, netCents: 96500 });
    await paid(id, 100000, 'R2');
    await save(id, { fee: { ...twoAndAHalf, floorCents: 5000 } });
    await deps.sweep.run(new Date(t0.getTime() + 6 * 60_000));
    expect((await sweepsOf(id))[0]).toMatchObject({ grossCents: 100000, feeCents: 5000, netCents: 95000 });
    await paid(id, 100000, 'R3');
    await save(id, { fee: { ...twoAndAHalf, ceilingCents: 2000 } });
    await deps.sweep.run(new Date(t0.getTime() + 12 * 60_000));
    expect((await sweepsOf(id))[0]).toMatchObject({ grossCents: 100000, feeCents: 2000, netCents: 98000 });
    // The phone got the net, and the fee stayed behind: that is the whole of the arithmetic.
    const sent = await b2cRows();
    expect(sent.map((r) => Number(r.amount_cents))).toEqual([96500, 95000, 98000]);
  });

  it('answers what is owed from the rows, never from a balance', async () => {
    const id = await newBusiness();
    await save(id, { fee: { percentBp: 100, flatCents: 0, floorCents: null, ceilingCents: null } });
    await paid(id, 100000, 'R1');
    await floatIs(5_000_000);
    await deps.sweep.run();
    await fake.settle();
    await deps.sweep.run();
    const after = await deps.sweep.one(id);
    expect(after.owed).toMatchObject({ paidInCents: 100000, sweptCents: 100000, feesTakenCents: 1000, owedCents: 0 });
    expect(after.owed.payments).toHaveLength(0);
    // The sum walks back: what left plus what was kept is exactly what arrived.
    expect(after.owed.sweptCents).toBe(after.owed.paidInCents);
    await paid(id, 25000, 'R2');
    const next = await deps.sweep.one(id);
    expect(next.owed.owedCents).toBe(25000);
    // The figure and the payments beside it are the same money.
    expect(next.owed.payments.reduce((sum, p) => sum + p.amountCents, 0)).toBe(next.owed.owedCents);
    expect(next.owed.payments.map((p) => p.receipt)).toEqual(['R2']);
  });

  it('retries a failed sweep in the next window, without a second payment', async () => {
    const id = await newBusiness();
    await save(id);
    await paid(id, 500000, 'R1');
    await floatIs(5_000_000);
    const t0 = new Date();
    fake.rejectsSync('1', 'The balance is insufficient.');
    expect(await deps.sweep.run(t0)).toMatchObject({ failed: 1, sent: 0 });
    const failed = await b2cRows();
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('failed');
    expect((await sweepsOf(id))[0]).toMatchObject({ state: 'failed' });
    // Nothing moved, so the money is still owed — and the failed row is never sent again.
    expect((await deps.sweep.one(id)).owed.owedCents).toBe(500000);
    await deps.sweep.run(new Date(t0.getTime() + 6 * 60_000));
    await fake.settle();
    await deps.sweep.run();
    const rows = await sweepsOf(id);
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe('sent');
    expect(rows[1].state).toBe('failed');
    const all = await b2cRows();
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.status === 'completed')).toHaveLength(1);
    expect((await deps.sweep.one(id)).owed.owedCents).toBe(0);
  });

  it('never sweeps a business with no destination, and says so plainly', async () => {
    const id = await newBusiness();
    await paid(id, 500000, 'R1');
    await floatIs(5_000_000);
    expect(await deps.sweep.run()).toMatchObject({ businesses: 0, sent: 0, held: 0, skipped: 0 });
    expect(await b2cRows()).toHaveLength(0);
    const view = await deps.sweep.one(id);
    expect(view.destinationPhone).toBeNull();
    expect(view.waiting).toMatchObject({ code: 'no_destination' });
    expect(view.waiting!.text).toContain('No phone yet');
    expect(view.owed.owedCents).toBe(500000);
  });

  it('needs the step-up to change where the money goes, and writes an audit row', async () => {
    const id = await newBusiness();
    const body = { destinationPhone: '0712345678', schedule: 'daily', hour: 9, weekday: 1, fee: noFee };
    const refused = await h(request(app).post('/api/sweep/' + id)).send(body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('step_up_required');
    expect((await deps.sweep.one(id)).destinationPhone).toBeNull();
    const saved = await save(id, { schedule: 'daily', hour: 9 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ destinationPhone: '254712345678', schedule: 'daily', hour: 9, timetable: 'every day at 09:00' });
    // Consent is taken once, when there is first somewhere for the money to go.
    expect(saved.body.consentedAt).toBeTruthy();
    const first = await deps.db.query<{ after_json: Record<string, unknown> }>(
      `SELECT after_json FROM audit_log WHERE action='sweep.settings_changed' AND target=$1 ORDER BY at`, [id]);
    expect(first).toHaveLength(1);
    expect(first[0].after_json).toMatchObject({ destinationPhone: '254712345678', schedule: 'daily', hour: 9 });
    // Changing the phone is a second row, naming the phone it moved from and to.
    expect((await save(id, { destinationPhone: '0722000111', schedule: 'daily', hour: 9 })).status).toBe(200);
    const rows = await deps.db.query<{ before_json: Record<string, unknown>; after_json: Record<string, unknown> }>(
      `SELECT before_json, after_json FROM audit_log WHERE action='sweep.settings_changed' AND target=$1 ORDER BY at, id`, [id]);
    expect(rows).toHaveLength(2);
    expect(rows[1].before_json).toMatchObject({ destinationPhone: '254712345678' });
    expect(rows[1].after_json).toMatchObject({ destinationPhone: '254722000111' });
  });

  it('stops with one press, leaves the money owed and visible, and sends nothing', async () => {
    const id = await newBusiness();
    await save(id);
    await paid(id, 500000, 'R1');
    await floatIs(5_000_000);
    // No password in the body: stopping has to be the easy thing to do.
    const stopped = await h(request(app).post('/api/sweep/' + id + '/stop')).send({ stopped: true });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ stopped: true, waiting: { code: 'stopped' } });
    expect(stopped.body.owed).toMatchObject({ owedCents: 500000 });
    expect(stopped.body.owed.payments).toHaveLength(1);
    expect(await deps.sweep.run()).toMatchObject({ sent: 0, held: 0, skipped: 0 });
    expect(await b2cRows()).toHaveLength(0);
    // Starting again is the same one press, and the money that waited goes.
    expect((await h(request(app).post('/api/sweep/' + id + '/stop')).send({ stopped: false })).status).toBe(200);
    expect((await deps.sweep.run()).sent).toBe(1);
    expect(await b2cRows()).toHaveLength(1);
  });

  it('sweeps nothing at all while the module is off, whatever the timetable says', async () => {
    const id = await newBusiness();
    await save(id);
    await paid(id, 500000, 'R1');
    await floatIs(5_000_000);
    const off = await h(request(app).post('/api/modules/sweep')).send({ enabled: false, password: PW });
    expect(off.status).toBe(200);
    expect((await h(request(app).get('/api/sweep'))).status).toBe(409);
    expect(await deps.sweep.run()).toMatchObject({ businesses: 0, sent: 0 });
    expect(await b2cRows()).toHaveLength(0);
    // And back on, the same money goes: nothing was lost by switching it off.
    expect((await h(request(app).post('/api/modules/sweep')).send({ enabled: true, password: PW })).status).toBe(200);
    expect((await deps.sweep.run()).sent).toBe(1);
  });
});

describe('windows and fees', () => {
  // A Saturday evening in Nairobi: 21:07 on 19 September 2026.
  const at = new Date('2026-09-19T18:07:00Z');

  it('names one window per timetable on the Nairobi clock, and knows when it is due', () => {
    expect(windowFor({ schedule: 'arrival', hour: 20, weekday: 1 }, at)).toEqual({ window: 'arrival:2026-09-19T21:05', due: true });
    // The hour has not come round yet today.
    expect(windowFor({ schedule: 'daily', hour: 22, weekday: 1 }, at)).toEqual({ window: 'daily:2026-09-19', due: false });
    expect(windowFor({ schedule: 'daily', hour: 21, weekday: 1 }, at)).toEqual({ window: 'daily:2026-09-19', due: true });
    // Nine at night is already past, so a restart in the afternoon still sweeps today.
    expect(windowFor({ schedule: 'daily', hour: 9, weekday: 1 }, at)).toEqual({ window: 'daily:2026-09-19', due: true });
    // Saturday the 19th: the most recent Monday is the 14th.
    expect(windowFor({ schedule: 'weekly', hour: 20, weekday: 0 }, at)).toEqual({ window: 'weekly:2026-09-14', due: true });
    expect(windowFor({ schedule: 'weekly', hour: 20, weekday: 5 }, at)).toEqual({ window: 'weekly:2026-09-19', due: true });
    expect(windowFor({ schedule: 'weekly', hour: 20, weekday: 6 }, at)).toEqual({ window: 'weekly:2026-09-13', due: true });
  });

  it('rounds the fee to the shilling and honours the floor and the ceiling', () => {
    const base = { percentBp: 250, flatCents: 1000, floorCents: null, ceilingCents: null };
    // 2.5% of KES 1,000 is KES 25, plus KES 10.
    expect(feeFor(100000, base)).toBe(3500);
    expect(netOf(100000, base)).toBe(96500);
    // Half a shilling is not a thing: KES 2.50 rounds up to KES 3.
    expect(feeFor(10000, { ...base, flatCents: 0 })).toBe(300);
    expect(feeFor(10000, { ...base, flatCents: 0, floorCents: 500 })).toBe(500);
    expect(feeFor(10000, { ...base, flatCents: 0, ceilingCents: 100 })).toBe(100);
    // The floor is applied after the sum, never instead of it.
    expect(feeFor(100000, { ...base, floorCents: 2000 })).toBe(3500);
    // A fee can never be more than the money it is taken from.
    expect(feeFor(100, { percentBp: 10000, flatCents: 5000, floorCents: null, ceilingCents: null })).toBe(100);
    expect(feeFor(0, base)).toBe(0);
  });
});
