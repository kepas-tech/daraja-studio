import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { C2bPayment } from '@kepas/daraja-js';
import { makeApp, loginAsOwner, loginAs, makePerson, resetTables, TEST_ORG_ID } from './helpers.js';
import { createAdminPool, withSystem } from '../src/db/pool.js';
import { recordC2b } from '../src/money_in/record.js';
import { parseAccount, readNumber, type KnownAccount } from '../src/businesses/match.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { createNotificationsService } from '../src/notifications/service.js';
import { createNotificationWriter } from '../src/notifications/writer.js';
import type { StudioEvent } from '../src/events/hub.js';

/**
 * Brief 2, item 1: the three-level account number — a business code, a customer number Studio
 * draws at random, and an optional account under it — and the split rule that reads what a payer
 * typed. Real PostgreSQL throughout; the only Safaricom in sight is the in-process fake below, so
 * nothing here can move money.
 */

// A small valid PNG; the QR path never contacts a provider.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const b2cAck = vi.fn(async (input: { originatorConversationId: string }) => ({
  conversationId: 'AG_1', originatorConversationId: input.originatorConversationId,
  responseCode: '0', responseDescription: 'Accept the service request successfully.',
}));
const stkPush = vi.fn(async () => ({ merchantRequestId: 'MR_1', checkoutRequestId: 'ws_CO_1', responseCode: '0', responseDescription: 'Success. Request accepted for processing', customerMessage: 'Success' }));
const qrGenerate = vi.fn(async () => ({ responseCode: '00', responseDescription: 'Success', qrCode: PNG }));
const sendInvoice = vi.fn(async () => ({ responseCode: '200', responseDescription: 'Invoice sent' }));
const config = { shortcode: '600999', environment: 'sandbox', initiator: 'APIONE' };
const factory: DarajaFactory = {
  get: async () => ({ collect: { stkPush }, qr: { generate: qrGenerate }, billManager: { sendInvoice }, b2c: { send: b2cAck }, config }) as never,
  getForOperator: async () => ({ b2c: { send: b2cAck }, config }) as never,
  invalidate: () => {},
  stkEnabled: async () => true,
} as unknown as DarajaFactory;

const eatDay = (offsetDays = 0) => new Date(Date.now() + 3 * 3_600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);
let receiptSeq = 0;
const payment = (over: Partial<C2bPayment> = {}): C2bPayment => ({
  transactionType: 'Pay Bill', transId: ('R' + String(++receiptSeq).padStart(9, '0')).slice(0, 10),
  transTime: eatDay().replace(/-/g, '') + '120000', amount: 100, shortCode: '600999',
  billRefNumber: '000359', invoiceNumber: '', thirdPartyTransId: '',
  msisdn: '254700123456', firstName: 'Jane', middleName: '', lastName: 'Doe', ...over,
});

/**
 * The injected draw. A test that asserts an exact number fills the queue; everything else falls back
 * to real randomness, which the unique index keeps honest. The default is the same shape as the
 * production draw — an integer below the width's room.
 */
let queue: number[] = [];
const rng = (max: number) => (queue.length ? queue.shift()! : Math.floor(Math.random() * max));

describe('readNumber — the width is written into the number', () => {
  it('counts the leading 9s: 3 plus that many digits, and no more', () => {
    expect(readNumber('359')).toEqual({ number: '359', rest: '' });
    expect(readNumber('9359')).toEqual({ number: '9359', rest: '' });
    expect(readNumber('99359')).toEqual({ number: '99359', rest: '' });
    expect(readNumber('359123')).toEqual({ number: '359', rest: '123' });
    expect(readNumber('9359123')).toEqual({ number: '9359', rest: '123' });
    expect(readNumber('3599123')).toEqual({ number: '359', rest: '9123' });
  });
  it('refuses digits shorter than the width they announce', () => {
    expect(readNumber('99')).toBeNull();
    expect(readNumber('999')).toBeNull();
    expect(readNumber('99999')).toBeNull();
  });
});

describe('parseAccount — the self-describing rule, with no database', () => {
  const one = [{ id: 'b0', code: '000' }];
  const two = [{ id: 'b0', code: '000' }, { id: 'b1', code: '001' }];
  const acct = (id: string, businessId: string, number: string, parentId: string | null, fullNumber: string): KnownAccount =>
    ({ id, businessId, number, parentId, fullNumber, name: id });
  // Business 000: customer 359 with the account 123 under it, and a four-digit customer 9359.
  const books = [
    acct('c359', 'b0', '359', null, '000359'), acct('c359123', 'b0', '123', 'c359', '000359123'),
    acct('c9359', 'b0', '9359', null, '0009359'), acct('c9359123', 'b0', '123', 'c9359', '0009359123'),
  ];

  it('no businesses: nothing is decided', () => {
    expect(parseAccount('359', [], books)).toEqual({ kind: 'none' });
  });

  it('the owner\u2019s three examples read exactly one way', () => {
    expect(parseAccount('000359123', two, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: 'c359123' });
    expect(parseAccount('0009359123', two, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: 'c9359123' });
    // 0003599123 is customer 359 with an account 9123 under it, which nobody holds.
    expect(parseAccount('0003599123', two, books)).toEqual({ kind: 'unmatched', reason: 'no_sub', businessId: 'b0', accountName: 'c359' });
  });

  it('no account: the business is known and the customer is not, which a human sorts', () => {
    expect(parseAccount('000777', two, books)).toEqual({ kind: 'unmatched', reason: 'no_account', businessId: 'b0', accountName: null });
    expect(parseAccount('0009999', two, books)).toEqual({ kind: 'unmatched', reason: 'no_account', businessId: 'b0', accountName: null });
  });

  it('no sub-account: the customer is known and the account under it is not', () => {
    expect(parseAccount('000359777', two, books)).toEqual({ kind: 'unmatched', reason: 'no_sub', businessId: 'b0', accountName: 'c359' });
  });

  it('too many digits: a third level, or digits that cannot be read at all', () => {
    expect(parseAccount('000359123456', two, books)).toEqual({ kind: 'unmatched', reason: 'too_many', businessId: 'b0', accountName: null });
    expect(parseAccount('00035999', two, books)).toEqual({ kind: 'unmatched', reason: 'too_many', businessId: 'b0', accountName: null });
  });

  it('a code nobody owns, a short reference and letters are unmatched with two businesses', () => {
    expect(parseAccount('999359', two, books)).toEqual({ kind: 'unmatched', reason: 'no_business', businessId: null, accountName: null });
    expect(parseAccount('12', two, books)).toEqual({ kind: 'unmatched', reason: 'no_business', businessId: null, accountName: null });
    expect(parseAccount('12x', two, books)).toEqual({ kind: 'unmatched', reason: 'no_business', businessId: null, accountName: null });
    expect(parseAccount(null, two, books)).toEqual({ kind: 'unmatched', reason: 'no_business', businessId: null, accountName: null });
  });

  it('a known code with nothing after it is the business, not an unmatched row', () => {
    expect(parseAccount('001', two, books)).toEqual({ kind: 'matched', businessId: 'b1', accountId: null });
    expect(parseAccount('000', one, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: null });
  });

  it('leading zeros are not tolerated: numbers are fixed width and system printed', () => {
    expect(parseAccount('0000359', two, books)).toEqual({ kind: 'unmatched', reason: 'no_account', businessId: 'b0', accountName: null });
  });

  it('one business: routing is off, so both the printed full number and the bare account part resolve', () => {
    expect(parseAccount('359', one, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: 'c359' });
    expect(parseAccount('000359', one, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: 'c359' });
    expect(parseAccount('000359123', one, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: 'c359123' });
    expect(parseAccount('9359', one, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: 'c9359' });
  });

  it('one business: a number nobody holds is that business with nothing decided, and letters are not a reason to doubt it', () => {
    expect(parseAccount('777', one, books)).toEqual({ kind: 'unmatched', reason: 'no_account', businessId: 'b0', accountName: null });
    expect(parseAccount('12x', one, books)).toEqual({ kind: 'matched', businessId: 'b0', accountId: null });
  });
});
describe('businesses and their account numbers', () => {
  const { app, deps, close } = makeApp({ daraja: factory, rng });
  afterAll(close);
  let s: { cookie: string; csrf: string };
  beforeEach(async () => {
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.settings.set('env.sandbox.consumerKey', 'k');
    await deps.settings.set('env.sandbox.consumerSecret', 's');
    await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
    await deps.settings.set('env.sandbox.shortcode', '600999');
    await deps.settings.set('env.sandbox.billManagerAppKey', 'fake-app-key');
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
    b2cAck.mockClear(); stkPush.mockClear(); qrGenerate.mockClear(); sendInvoice.mockClear();
    queue = [];
  });
  const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
  const addBusiness = async (name: string) => (await h(request(app).post('/api/businesses')).send({ name })).body;
  const addAccount = async (businessId: string, name: string, extra: Record<string, unknown> = {}) =>
    (await h(request(app).post(`/api/businesses/` + businessId + `/accounts`)).send({ name, ...extra })).body;
  const addChild = async (parentId: string, name: string) =>
    (await h(request(app).post(`/api/accounts/` + parentId + `/sub-accounts`)).send({ name })).body;
  const rows = async (id: string) => (await deps.db.query<{ business_id: string | null; account_id: string | null }>(`SELECT business_id, account_id FROM requests WHERE id=$1`, [id]))[0];
  const seen = async (ref: string) => rows((await recordC2b(deps, payment({ billRefNumber: ref }), 'callback')).requestId);
  /** Open a width by hand: the tests about the number itself should not have to fill a real 900. */
  const openWidth = async (businessId: string, width: number) => {
    await deps.db.query(`UPDATE number_widths SET closed_at=now() WHERE scope_kind='accounts' AND scope_id=$1 AND closed_at IS NULL`, [businessId]);
    await deps.db.query(`INSERT INTO number_widths(scope_kind, scope_id, width) VALUES ('accounts',$1,$2)`, [businessId, width]);
  };

  it('the database refuses a bad code, a duplicate number, and a shape no reader could split', async () => {
    await addBusiness('Shop');
    await expect(deps.db.query(`INSERT INTO businesses(code, name) VALUES ('12','Bad')`)).rejects.toMatchObject({ code: '23514' });
    await expect(deps.db.query(`INSERT INTO businesses(code, name) VALUES ('000','Same code')`)).rejects.toMatchObject({ code: '23505' });
    const b = await addBusiness('Second');
    await deps.db.query(`INSERT INTO accounts(business_id, number, name) VALUES ($1, '359', 'Jane')`, [b.id]);
    await expect(deps.db.query(`INSERT INTO accounts(business_id, number, name) VALUES ($1, '359', 'Again')`, [b.id]))
      .rejects.toMatchObject({ code: '23505' });
    // Too short, a three-digit number starting with the reserved 9, and a stray shape are all refused:
    // every stored number must be one the reader can split.
    for (const bad of ['12', '959', '9935', '9']) {
      await expect(deps.db.query(`INSERT INTO accounts(business_id, number, name) VALUES ($1, $2, 'Bad')`, [b.id, bad]))
        .rejects.toMatchObject({ code: '23514' });
    }
    // A four-digit number is a leading 9 and then a first digit of 0-8.
    await deps.db.query(`INSERT INTO accounts(business_id, number, name) VALUES ($1, '9359', 'Jane four')`, [b.id]);
    await expect(deps.db.query(`INSERT INTO accounts(business_id, number, name) VALUES ($1, '9959', 'Two nines, three digits')`, [b.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('the database fills the full number, and refuses to let a number be edited or re-pointed', async () => {
    const b = await addBusiness('Shop');
    const [parent] = await deps.db.query<{ id: string; full_number: string }>(`INSERT INTO accounts(business_id, number, name) VALUES ($1,'359','Jane') RETURNING id, full_number`, [b.id]);
    expect(parent.full_number).toBe('000359');
    const [kid] = await deps.db.query<{ id: string; full_number: string }>(`INSERT INTO accounts(business_id, parent_id, number, name) VALUES ($1,$2,'123','Room 4') RETURNING id, full_number`, [b.id, parent.id]);
    expect(kid.full_number).toBe('000359123');
    await expect(deps.db.query(`UPDATE accounts SET number='899' WHERE id=$1`, [kid.id])).rejects.toMatchObject({ code: '23514' });
    await expect(deps.db.query(`UPDATE accounts SET parent_id=NULL WHERE id=$1`, [kid.id])).rejects.toMatchObject({ code: '23514' });
    // An account under an account is not allowed, and a parent must be in the same business.
    const other = await addBusiness('Other');
    await expect(deps.db.query(`INSERT INTO accounts(business_id, parent_id, number, name) VALUES ($1,$2,'456','Deeper')`, [b.id, kid.id]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(deps.db.query(`INSERT INTO accounts(business_id, parent_id, number, name) VALUES ($1,$2,'456','Elsewhere')`, [other.id, parent.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('draws a random number with the injected RNG, and 359 + 123 gives 000359 and 000359123', async () => {
    const b = await addBusiness('Shop');
    queue = [359, 123];
    const jane = await addAccount(b.id, 'Jane');
    expect(jane).toMatchObject({ number: '359', fullNumber: '000359', parentId: null, children: [] });
    const room = await addChild(jane.id, 'Room 4');
    expect(room).toMatchObject({ number: '123', fullNumber: '000359123', parentId: jane.id });
    const list = await h(request(app).get(`/api/businesses/` + b.id + `/accounts`));
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].children.map((k: { fullNumber: string }) => k.fullNumber)).toEqual(['000359123']);
  });

  it('every number at every width from 3 to 6 reads back to itself', async () => {
    const b = await addBusiness('Shop');
    // One account per width, written straight in: the parser is what is under test, and a mint can
    // only reach a longer width after 900 shorter numbers are used.
    const written = [
      { width: 3, number: '359' },
      { width: 4, number: '9359' },
      { width: 5, number: '99359' },
      { width: 6, number: '999359' },
    ];
    const made: { id: string; full: string }[] = [];
    for (const w of written) {
      const [row] = await deps.db.query<{ id: string; full_number: string }>(
        `INSERT INTO accounts(business_id, number, name) VALUES ($1,$2,$3) RETURNING id, full_number`,
        [b.id, w.number, 'Width ' + w.width]);
      // The width is the leading 9s and the digit after them is 0-8, which is what makes the reader
      // stop at the right place instead of swallowing the level below.
      expect(row.full_number.length).toBe(3 + w.width);
      expect(readNumber(w.number)).toEqual({ number: w.number, rest: '' });
      made.push({ id: row.id, full: row.full_number });
    }
    // A minted number reads back to itself too, through the same parser a callback uses.
    queue = [777];
    const minted = await addAccount(b.id, 'Minted');
    expect(readNumber(minted.number)).toEqual({ number: minted.number, rest: '' });
    made.push({ id: minted.id, full: minted.fullNumber });
    for (const m of made) expect(await seen(m.full)).toEqual({ business_id: b.id, account_id: m.id });
  });

  it('grows the width only when all 900 numbers of the open one are used, and says so out loud', async () => {
    const b = await addBusiness('Shop');
    // Every three-digit number: 000-899, which is exactly the shape a width of three may hold.
    await deps.db.query(`INSERT INTO accounts(business_id, number, name) SELECT $1, lpad(g::text, 3, '0'), 'Customer ' || g FROM generate_series(0, 899) g`, [b.id]);
    const events: StudioEvent[] = [];
    const off = deps.events.subscribe((e) => events.push(e));
    // The real path: pg_notify out, the hub's LISTEN connection back, the writer behind that.
    await deps.events.start();
    try {
      const next = await addAccount(b.id, 'The nine hundred and first');
      expect(next.number.length).toBe(4);
      expect(next.number[0]).toBe('9');
      expect(next.fullNumber).toBe('000' + next.number);
      // No three-digit number was reissued: every one is still held by its own row.
      const [held] = await deps.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM accounts WHERE business_id=$1 AND char_length(number)=3`, [b.id]);
      expect(held.n).toBe('900');
      // The mint skipped width 3 (all 900 live) and opened width 4, which is the row the tracker has:
      // a width written straight into the rows never needed a tracker row of its own.
      const widths = await deps.db.query<{ width: number; used: number; closed: boolean }>(
        `SELECT width, used, closed_at IS NOT NULL AS closed FROM number_widths WHERE scope_id=$1 ORDER BY width`, [b.id]);
      expect(widths).toEqual([{ width: 4, used: 1, closed: false }]);
      // An audit row names the scope and the new width, and the owner gets a line in the inbox.
      const [entry] = await deps.db.query<{ action: string; after_json: Record<string, unknown> }>(
        `SELECT action, after_json FROM audit_log WHERE action='accounts.width_grew' ORDER BY id DESC LIMIT 1`);
      expect(entry.action).toBe('accounts.width_grew');
      expect(entry.after_json).toMatchObject({ scope: 'accounts', width: 4, previousWidth: 3 });
      for (let i = 0; i < 100 && !events.some((e) => e.type === 'accounts.width_grew'); i++) await new Promise((r) => setTimeout(r, 20));
      const grew = events.filter((e) => e.type === 'accounts.width_grew');
      expect(grew.length).toBe(1);
      const writer = createNotificationWriter({ db: deps.db, events: deps.events, notifications: createNotificationsService({ db: deps.db, events: deps.events }) });
      await writer.handle(grew[0]!);
      const [line] = await deps.db.query<{ title: string; body: string; category: string }>(`SELECT title, body, category FROM notifications ORDER BY created_at DESC LIMIT 1`);
      expect(line.category).toBe('accounts');
      expect(line.body).toBe('Account numbers for Shop now have 4 digits. All 900 shorter numbers are used.');
    } finally { off(); await deps.events.stop(); }
  });

  it('shows the open width on the Businesses list: 3 digits, 1 of 900 used', async () => {
    const b = await addBusiness('Shop');
    queue = [359];
    await addAccount(b.id, 'Jane');
    const list = await h(request(app).get('/api/businesses'));
    expect(list.body.items[0].numbers).toEqual({ width: 3, capacity: 900, used: 1 });
    const bare = await addBusiness('Nothing yet');
    const after = await h(request(app).get('/api/businesses'));
    const row = (after.body.items as { id: string; numbers: unknown }[]).find((x) => x.id === bare.id)!;
    expect(row.numbers).toEqual({ width: 3, capacity: 900, used: 0 });
  });

  it('counts accounts that were written before the tracker existed', async () => {
    const b = await addBusiness('Shop');
    // No number_widths row at all: two accounts of the shortest width, as a carried-over business has.
    await deps.db.query(`INSERT INTO accounts(business_id, number, name) VALUES ($1,'000','Jane'), ($1,'359','John')`, [b.id]);
    const list = await h(request(app).get('/api/businesses'));
    expect(list.body.items[0].numbers).toEqual({ width: 3, capacity: 900, used: 2 });
  });

  it('deletes an account and its sub-accounts, and a later mint hands the freed number out again', async () => {
    const b = await addBusiness('Shop');
    queue = [359, 123];
    const jane = await addAccount(b.id, 'Jane');
    await addChild(jane.id, 'Room 4');
    expect(jane.number).toBe('359');

    const gone = await h(request(app).delete('/api/accounts/' + jane.id)).send({ name: 'Jane', password: 'correct horse' });
    expect(gone.status).toBe(204);
    const left = await deps.db.query(`SELECT id FROM accounts WHERE business_id=$1`, [b.id]);
    expect(left.length).toBe(0);

    // One history row per deleted row, with the digits, the level and who deleted it — and no phone.
    const history = await deps.db.query<{ full_number: string; level: string; name: string; deleted_by: string | null }>(
      `SELECT full_number, level, name, deleted_by FROM number_history ORDER BY level, full_number`);
    expect(history.map((x) => [x.level, x.full_number, x.name])).toEqual([
      ['account', '000359', 'Jane'],
      ['sub_account', '000359123', 'Room 4'],
    ]);
    expect(history.every((x) => x.deleted_by !== null)).toBe(true);
    const [auditRow] = await deps.db.query<{ after_json: Record<string, unknown>; before_json: Record<string, unknown> }>(
      `SELECT after_json, before_json FROM audit_log WHERE action='account.deleted' ORDER BY id DESC LIMIT 1`);
    expect(JSON.stringify(auditRow)).not.toContain('254712345678');

    // The digits are free again: the same draw hands the same number to somebody else.
    queue = [359];
    const next = await addAccount(b.id, 'Peter');
    expect(next.number).toBe('359');
  });

  it('mints from the lowest width with a free number, and reopens a width that was closed', async () => {
    const b = await addBusiness('Shop');
    // 899 rows, so the next mint fills width 3 and opens the tracker's row for it.
    await deps.db.query(`INSERT INTO accounts(business_id, number, name) SELECT $1, lpad(g::text, 3, '0'), 'Holder ' || g FROM generate_series(0, 898) g`, [b.id]);
    queue = [899];
    const last = await addAccount(b.id, 'Nine hundredth');
    expect(last.number.length).toBe(3);
    const [full] = await deps.db.query<{ used: number; closed: boolean }>(
      `SELECT used, closed_at IS NOT NULL AS closed FROM number_widths WHERE scope_kind='accounts' AND scope_id=$1 AND width=3`, [b.id]);
    expect(full).toEqual({ used: 900, closed: false });

    // Every shorter number is in use, so the next account gets a four-digit one and width 3 closes.
    const grew = await addAccount(b.id, 'Nine hundred and first');
    expect(grew.number.length).toBe(4);
    const [closed] = await deps.db.query<{ used: number; closed: boolean }>(
      `SELECT used, closed_at IS NOT NULL AS closed FROM number_widths WHERE scope_kind='accounts' AND scope_id=$1 AND width=3`, [b.id]);
    expect(closed).toEqual({ used: 900, closed: true });

    // Free one three-digit number: the next mint takes that one, not another four-digit number, and
    // the width that was closed is open again with the live count.
    const [victim] = await deps.db.query<{ id: string; number: string }>(`SELECT id, number FROM accounts WHERE business_id=$1 AND number='005'`, [b.id]);
    const deleted = await h(request(app).delete('/api/accounts/' + victim.id)).send({ name: 'Holder 5', password: 'correct horse' });
    expect(deleted.status).toBe(204);
    queue = [5];
    const reused = await addAccount(b.id, 'New holder of 005');
    expect(reused.number).toBe('005');
    expect(reused.number.length).toBe(3);
    const [reopened] = await deps.db.query<{ used: number; closed: boolean }>(
      `SELECT used, closed_at IS NOT NULL AS closed FROM number_widths WHERE scope_kind='accounts' AND scope_id=$1 AND width=3`, [b.id]);
    expect(reopened).toEqual({ used: 900, closed: false });
  });

  it('will not delete without the exact name and the password, and deletes nothing when either is wrong', async () => {
    const b = await addBusiness('Shop');
    queue = [359];
    const jane = await addAccount(b.id, 'Jane');
    const wrongName = await h(request(app).delete('/api/accounts/' + jane.id)).send({ name: 'Janet', password: 'correct horse' });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.code).toBe('name_mismatch');
    const wrongPassword = await h(request(app).delete('/api/accounts/' + jane.id)).send({ name: 'Jane', password: 'not the password' });
    expect(wrongPassword.status).toBe(403);
    expect((await deps.db.query(`SELECT id FROM accounts WHERE id=$1`, [jane.id])).length).toBe(1);
    expect((await deps.db.query(`SELECT id FROM number_history`)).length).toBe(0);
    // Both right, and it goes.
    expect((await h(request(app).delete('/api/accounts/' + jane.id)).send({ name: 'Jane', password: 'correct horse' })).status).toBe(204);
  });

  it('refuses to delete a business while accounts remain, then frees its code', async () => {
    const b = await addBusiness('Shop');
    queue = [359];
    const jane = await addAccount(b.id, 'Jane');
    const refused = await h(request(app).delete('/api/businesses/' + b.id)).send({ name: 'Shop', password: 'correct horse' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('accounts_remain');
    await h(request(app).delete('/api/accounts/' + jane.id)).send({ name: 'Jane', password: 'correct horse' });
    const gone = await h(request(app).delete('/api/businesses/' + b.id)).send({ name: 'Shop', password: 'correct horse' });
    expect(gone.status).toBe(204);
    const [row] = await deps.db.query<{ level: string; full_number: string; name: string }>(`SELECT level, full_number, name FROM number_history WHERE level='business'`);
    expect(row).toEqual({ level: 'business', full_number: '000', name: 'Shop' });
    // The code is free again: the next business gets 000.
    expect((await addBusiness('Another shop')).code).toBe('000');
  });

  it('shows who held a number before, to the account page and to the money that arrived on it', async () => {
    const b = await addBusiness('Shop');
    queue = [359];
    const jane = await addAccount(b.id, 'Jane');
    await recordC2b(deps, payment({ billRefNumber: '000359' }), 'callback');
    await h(request(app).delete('/api/accounts/' + jane.id)).send({ name: 'Jane', password: 'correct horse' });

    // An old money row keeps the digits and says who held them.
    const rows = await h(request(app).get('/api/requests?limit=5'));
    const c2b = rows.body.items.find((x: { type: string }) => x.type === 'c2b');
    expect(c2b).toMatchObject({ accountReference: '000359', deletedAccountName: 'Jane', accountId: null });
    expect(typeof c2b.deletedAccountAt).toBe('string');

    // Hand the same digits out again: the new account explains where they came from.
    queue = [359];
    const peter = await addAccount(b.id, 'Peter');
    const accounts = await h(request(app).get(`/api/businesses/` + b.id + `/accounts`));
    const view = accounts.body.items.find((x: { id: string }) => x.id === peter.id);
    expect(view.previousHolder.name).toBe('Jane');
    expect(typeof view.previousHolder.until).toBe('string');

    // Past holders of this number: the account that went, and nothing invented.
    const history = await h(request(app).get('/api/accounts/' + peter.id + '/history'));
    expect(history.status).toBe(200);
    expect(history.body.items.map((x: { name: string }) => x.name)).toEqual(['Jane']);
  });

  it('a deleted account does not stop the same number being paid again', async () => {
    const b = await addBusiness('Shop');
    queue = [359];
    const jane = await addAccount(b.id, 'Jane');
    await h(request(app).delete('/api/accounts/' + jane.id)).send({ name: 'Jane', password: 'correct horse' });
    // Nobody holds 359 now, so the payment is unmatched and a human sorts it, exactly as before.
    const row = await recordC2b(deps, payment({ billRefNumber: '000359' }), 'callback');
    expect(await rows(row.requestId)).toEqual({ business_id: b.id, account_id: null });
  });

  it('one business: the printed reading wins when the digits could be read two ways', async () => {
    // Customer 359 (printed 000359) and customer 000 with the account 359 under it (printed
    // 000000359). Only the printed number decides, so 000359 is always Jane.
    const b = await addBusiness('Shop');
    queue = [359, 0, 359];
    const jane = await addAccount(b.id, 'Jane');
    const zero = await addAccount(b.id, 'Zero');
    const room = await addChild(zero.id, 'Room 4');
    expect(jane.fullNumber).toBe('000359');
    expect(room.fullNumber).toBe('000000359');
    expect(await seen('000359')).toEqual({ business_id: b.id, account_id: jane.id });
    expect(await seen('000000359')).toEqual({ business_id: b.id, account_id: room.id });
    expect(await seen('000999')).toEqual({ business_id: b.id, account_id: null });
    expect(await seen('12x')).toEqual({ business_id: b.id, account_id: null });
  });

  it('two businesses: the code decides, and the account under a customer is reachable by its full number', async () => {
    const b0 = await addBusiness('First');
    const b1 = await addBusiness('Second');
    queue = [359, 123];
    const jane = await addAccount(b1.id, 'Jane');
    const room = await addChild(jane.id, 'Room 4');
    expect(await seen('001359')).toEqual({ business_id: b1.id, account_id: jane.id });
    expect(await seen('001359123')).toEqual({ business_id: b1.id, account_id: room.id });
    expect(await seen('999359')).toEqual({ business_id: null, account_id: null });
    expect(await seen('001999')).toEqual({ business_id: b1.id, account_id: null });
    expect(await seen('001')).toEqual({ business_id: b1.id, account_id: null });
    expect(await seen('000')).toEqual({ business_id: b0.id, account_id: null });
  });

  it('names each reason a payment needs sorting, with the fix that labels it and nothing else', async () => {
    await addBusiness('First');
    const b1 = await addBusiness('Second');
    queue = [359, 123];
    const jane = await addAccount(b1.id, 'Jane');
    const room = await addChild(jane.id, 'Room 4');
    const unknownCode = await recordC2b(deps, payment({ billRefNumber: '999359', amount: 250 }), 'callback');
    const unknownAccount = await recordC2b(deps, payment({ billRefNumber: '001999', amount: 500 }), 'callback');
    const unknownSub = await recordC2b(deps, payment({ billRefNumber: '001359777', amount: 750 }), 'callback');

    const before = await h(request(app).get('/api/money-in/unmatched'));
    expect(before.status).toBe(200);
    const items = before.body.items as Record<string, unknown>[];
    expect(items.length).toBe(3);
    const byReason = (reason: string) => items.find((i) => i.reason === reason)!;
    expect(byReason('no_account')).toMatchObject({ reason: 'no_account', businessId: b1.id, accountReference: '001999', businessName: 'Second', amountCents: 50000, accountName: null });
    expect(byReason('no_business')).toMatchObject({ reason: 'no_business', businessId: null, accountReference: '999359' });
    expect(byReason('no_sub')).toMatchObject({ reason: 'no_sub', businessId: b1.id, accountName: 'Jane', accountReference: '001359777' });
    // The shape the web side reads: no candidates list any more, and the ordinary view fields are there.
    expect('candidates' in byReason('no_account')).toBe(false);
    expect(typeof byReason('no_account').id).toBe('string');
    expect((byReason('no_account').recipient as { value: string }).value).toBe('254700123456');

    // Fix one: the code nobody owned is labelled with a business.
    const assigned2 = await h(request(app).post('/api/businesses/assign/' + unknownCode.requestId)).send({ businessId: b1.id });
    expect(assigned2.status).toBe(200);
    expect(assigned2.body.businessName).toBe('Second');
    // Fix two: the account the payer typed nobody holds is labelled with a live account.
    const assigned = await h(request(app).post('/api/businesses/assign/' + unknownAccount.requestId)).send({ businessId: b1.id, accountId: jane.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ accountName: 'Jane', accountNumber: '001359', businessName: 'Second', amountCents: 50000 });
    // Fix three: the customer is known, so the account under her is one click away.
    const assigned3 = await h(request(app).post('/api/businesses/assign/' + unknownSub.requestId)).send({ businessId: b1.id, accountId: room.id });
    expect(assigned3.status).toBe(200);
    expect(assigned3.body.accountNumber).toBe('001359123');

    const kept = await deps.db.query<{ id: string; amount_cents: string; receipt: string | null }>(`SELECT id, amount_cents, receipt FROM requests WHERE id = ANY($1)`, [[unknownCode.requestId, unknownAccount.requestId]]);
    const byId = new Map(kept.map((r) => [r.id, r]));
    expect(Number(byId.get(unknownCode.requestId)!.amount_cents)).toBe(25000);
    expect(byId.get(unknownAccount.requestId)!.receipt).toBeTruthy();
    const audits = await deps.db.query(`SELECT target FROM audit_log WHERE action='money_in.assigned' ORDER BY id`);
    expect(audits.map((a) => (a as { target: string }).target).sort()).toEqual([unknownCode.requestId, unknownAccount.requestId, unknownSub.requestId].sort());
    expect((await h(request(app).get('/api/money-in/unmatched'))).body.items.length).toBe(0);
  });

  it('refuses an assign that is not a c2b row, one with a business that is not there, and one with a foreign account', async () => {
    const b = await addBusiness('Shop');
    const row = await recordC2b(deps, payment({ billRefNumber: '000999' }), 'callback');
    const send = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, password: 'correct horse' });
    expect(send.status).toBe(201);
    const notC2b = await h(request(app).post('/api/businesses/assign/' + send.body.id)).send({ businessId: b.id });
    expect(notC2b.status).toBe(400);
    expect(notC2b.body.error.code).toBe('not_c2b');
    const missing = await h(request(app).post('/api/businesses/assign/' + row.requestId)).send({ businessId: '00000000-0000-4000-8000-0000000000ff' });
    expect(missing.status).toBe(404);
    const other = await addBusiness('Other');
    const elsewhere = await addAccount(other.id, 'Not here');
    const wrong = await h(request(app).post('/api/businesses/assign/' + row.requestId)).send({ businessId: b.id, accountId: elsewhere.id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('unknown_account');
  });

  it('every money-out path fills the business and the full number: a send, an STK ask, a QR code and an invoice', async () => {
    const b = await addBusiness('Shop');
    queue = [359, 123];
    const jane = await addAccount(b.id, 'Jane');
    const room = await addChild(jane.id, 'Room 4');

    // Money out: the row is labelled with the account, and the account carries its business.
    const sent = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, accountId: room.id, password: 'correct horse' });
    expect(sent.status).toBe(201);
    expect(await rows(sent.body.id)).toEqual({ business_id: b.id, account_id: room.id });
    expect((await h(request(app).get('/api/businesses'))).body.lastUsedId).toBe(b.id);

    // Ask a customer to pay: the prompt carries the full number, not what the form held.
    const asked = await h(request(app).post('/api/collect/stk')).send({ phone: '0700123456', amountCents: 10000, accountReference: 'ignored', accountId: room.id });
    expect(asked.status).toBe(201);
    expect(stkPush).toHaveBeenCalledWith(expect.objectContaining({ accountReference: '000359123' }));
    expect(await rows(asked.body.id)).toEqual({ business_id: b.id, account_id: room.id });

    // QR: the code carries it too.
    const qr = await h(request(app).post('/api/qr')).send({ accountReference: 'ignored', amountCents: 12550, trxCode: 'PB', accountId: jane.id });
    expect(qr.status).toBe(200);
    expect(qrGenerate).toHaveBeenCalledWith(expect.objectContaining({ accountReference: '000359' }));
    expect(qr.body.accountReference).toBe('000359');

    // Invoices: the payer is billed against it, and the stored row carries it.
    const inv = await h(request(app).post('/api/invoices')).send({ customerName: 'Jane Doe', customerPhone: '0700123456', invoiceName: 'September rent', accountReference: 'ignored', billedPeriod: 'September 2026', dueDate: '2099-09-30', amountCents: 150000, accountId: room.id });
    expect(inv.status).toBe(201);
    expect(sendInvoice).toHaveBeenCalledWith(expect.objectContaining({ accountReference: '000359123' }));
    const [stored] = await deps.db.query<{ account_reference: string }>(`SELECT account_reference FROM customer_invoices WHERE id=$1`, [inv.body.id]);
    expect(stored.account_reference).toBe('000359123');
  });

  it('a path with no account named behaves exactly as before', async () => {
    const b = await addBusiness('Shop');
    const sent = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, businessId: b.id, password: 'correct horse' });
    expect(sent.status).toBe(201);
    expect(await rows(sent.body.id)).toEqual({ business_id: b.id, account_id: null });
    const asked = await h(request(app).post('/api/collect/stk')).send({ phone: '0700123456', amountCents: 10000, accountReference: 'INV-7' });
    expect(asked.status).toBe(201);
    expect(stkPush).toHaveBeenCalledWith(expect.objectContaining({ accountReference: 'INV-7' }));
    const unknown = await h(request(app).post('/api/send/phone')).send({ phone: '0700123457', amountCents: 10000, businessId: '00000000-0000-4000-8000-0000000000ff', password: 'correct horse' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('unknown_business');
    const gone = await h(request(app).post('/api/send/phone')).send({ phone: '0700123458', amountCents: 10000, accountId: '00000000-0000-4000-8000-0000000000ff', password: 'correct horse' });
    expect(gone.status).toBe(400);
    expect(gone.body.error.code).toBe('unknown_account');
    expect((await deps.db.query(`SELECT 1 FROM requests WHERE recipient_value = ANY($1)`, [['254700123457', '254700123458']])).length).toBe(0);
  });

  it('refuses another organisation\u2019s business before anything is written', async () => {
    const otherOrg = '00000000-0000-4000-8000-000000000002';
    const admin = createAdminPool(process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@127.0.0.1:5434/studio_test');
    try {
      await withSystem(() => admin.query(`INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc) VALUES ($1,'other','Other','verified',false,'unused','unset') ON CONFLICT (id) DO NOTHING`, [otherOrg]));
      const [foreign] = await withSystem(() => admin.query<{ id: string }>(`INSERT INTO businesses(org_id, code, name) VALUES ($1,'000','Theirs') RETURNING id`, [otherOrg]));
      const r = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 10000, businessId: foreign.id, password: 'correct horse' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('unknown_business');
      expect((await deps.db.query(`SELECT 1 FROM requests`)).length).toBe(0);
    } finally {
      await withSystem(() => admin.query(`DELETE FROM orgs WHERE id=$1`, [otherOrg]));
      await admin.end();
    }
  });

  it('a bulk batch carries its business into every row', async () => {
    const b = await addBusiness('Shop');
    const created = await h(request(app).post('/api/send/bulk')).send({ text: '0700123456,100,Jane\n0700123457,200,John', businessId: b.id, password: 'correct horse' });
    expect(created.status).toBe(201);
    expect(created.body.businessId).toBe(b.id);
    await deps.bulk.drain(created.body.id);
    const kept = await deps.db.query<{ business_id: string | null }>(`SELECT business_id FROM requests WHERE bulk_plan_id=$1`, [created.body.id]);
    expect(kept.length).toBe(2);
    expect(kept.every((r) => r.business_id === b.id)).toBe(true);
  });

  it('summarises in and out per business for the day asked about', async () => {
    const b0 = await addBusiness('First');
    const b1 = await addBusiness('Second');
    await addAccount(b0.id, 'Jane');
    await recordC2b(deps, payment({ billRefNumber: '000999', amount: 300 }), 'callback');
    await recordC2b(deps, payment({ billRefNumber: '001999', amount: 500 }), 'callback');
    const sent = await h(request(app).post('/api/send/phone')).send({ phone: '0700123456', amountCents: 12000, businessId: b0.id, password: 'correct horse' });
    expect(sent.status).toBe(201);

    const today = await h(request(app).get('/api/businesses/summary'));
    expect(today.status).toBe(200);
    expect(Object.keys(today.body)).toEqual(['items']);
    const items = today.body.items as { businessId: string; code: string; name: string; inCents: number; outCents: number }[];
    expect(items.map((i) => i.code)).toEqual(['000', '001']);
    expect(items[0]).toMatchObject({ businessId: b0.id, name: 'First', inCents: 30000, outCents: 12000 });
    expect(items[1]).toMatchObject({ businessId: b1.id, name: 'Second', inCents: 50000, outCents: 0 });
    const other = await h(request(app).get('/api/businesses/summary?day=2020-01-01'));
    expect(other.body.items.map((i: { inCents: number; outCents: number }) => [i.inCents, i.outCents])).toEqual([[0, 0], [0, 0]]);
  });

  it('filters History by an account, and by a customer it includes the accounts under it', async () => {
    const b = await addBusiness('Shop');
    queue = [359, 123];
    const jane = await addAccount(b.id, 'Jane');
    const room = await addChild(jane.id, 'Room 4');
    const atJane = await recordC2b(deps, payment({ billRefNumber: '000359' }), 'callback');
    const atRoom = await recordC2b(deps, payment({ billRefNumber: '000359123' }), 'callback');
    const byCustomer = await h(request(app).get('/api/requests?accountId=' + jane.id));
    expect(byCustomer.status).toBe(200);
    expect(byCustomer.body.items.map((r: { id: string }) => r.id).sort()).toEqual([atJane.requestId, atRoom.requestId].sort());
    const byRoom = await h(request(app).get('/api/requests?accountId=' + room.id));
    expect(byRoom.body.items.map((r: { id: string }) => r.id)).toEqual([atRoom.requestId]);
  });

  it('hands out the next free code, lowest first, and refuses one from a client', async () => {
    expect((await addBusiness('First')).code).toBe('000');
    expect((await addBusiness('Second')).code).toBe('001');
    // A code is Studio's to give, exactly like an account number: sending one is a 400, and the
    // refusal writes nothing, so the code the client asked for is not even reserved.
    for (const body of [{ name: 'Clash', code: '007' }, { name: 'Clash', code: 7 }]) {
      const refused = await h(request(app).post('/api/businesses')).send(body);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('invalid');
    }
    expect((await deps.db.query(`SELECT 1 FROM businesses WHERE name = 'Clash'`)).length).toBe(0);
    expect((await addBusiness('Third')).code).toBe('002');
    const list = await h(request(app).get('/api/businesses'));
    expect(list.body.items.map((b: { code: string }) => b.code)).toEqual(['000', '001', '002']);
    expect(list.body.lastUsedId).toBeNull();
  });

  it('lets anyone signed in read, and only businesses.manage write', async () => {
    const b = await addBusiness('Shop');
    const viewerId = await makePerson(deps.db, TEST_ORG_ID, { username: 'viewer', password: 'a long enough one', role: 'viewer' });
    expect(viewerId).toBeTruthy();
    const v = await loginAs(app, 'viewer', 'a long enough one');
    const vh = (r: request.Test) => r.set('Cookie', v.cookie).set('x-csrf-token', v.csrf);
    expect((await vh(request(app).get('/api/businesses'))).status).toBe(200);
    expect((await vh(request(app).get(`/api/businesses/` + b.id + `/accounts`))).status).toBe(200);
    expect((await vh(request(app).post('/api/businesses')).send({ name: 'Nope' })).status).toBe(403);
    expect((await vh(request(app).post(`/api/businesses/` + b.id + `/accounts`)).send({ name: 'Nope' })).status).toBe(403);
  });
});
