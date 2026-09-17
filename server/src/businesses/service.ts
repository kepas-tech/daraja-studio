import { normalizePhone } from '@kepas/daraja-js';
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { Settings } from '../settings/store.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { getRequest, type RequestView } from '../money_out/reads.js';
import { MONEY_TYPES } from '../money_out/registry.js';
import { loadIndex, parseAccount, type UnmatchedReason } from './match.js';

/**
 * Brief 2, items 1 and 1b: the businesses one paybill serves, and the account numbers Studio draws
 * for each. Three levels, digits only — a business code, an account, an optional sub-account under
 * it — and every digit is Studio's to choose, so no form has a number box and no route accepts
 * one. A number carries its own width (see match.ts), so a payer's digits can never route to the
 * wrong account.
 *
 * Delete means delete: the row goes, the number returns to the free pool of its width, and
 * number_history keeps who held it. Nothing here reads or writes money: an assign only labels a row
 * a human has read.
 */

export interface Actor { personId: string; ip: string }
/** The open width of a scope, for the plain line the Businesses page shows. */
export interface NumberWidth { width: number; capacity: number; used: number }
export interface BusinessView { id: string; code: string; name: string; active: boolean; accountCount: number; numbers: NumberWidth; createdAt: string }
/** Who held this number before it was handed out again, when that was within the last year. */
export interface PastHolder { name: string; until: string }
export interface AccountView {
  id: string; businessId: string; parentId: string | null; number: string; fullNumber: string;
  name: string; phone: string | null; note: string | null; createdAt: string;
  /** Live sub-accounts under this account, in number order; always empty for a sub-account. */
  children: AccountView[];
  /** The number belonged to somebody else until `until`, within the last twelve months. */
  previousHolder: PastHolder | null;
}
/**
 * One money-in row that needs a human decision: the ordinary RequestView the page already renders,
 * plus why it is here. Contract fixed with the web side — flat fields, no nested business object.
 */
export type UnmatchedPayment = RequestView & {
  reason: UnmatchedReason;
  /** The known business, for the reasons that name one; null for no_business. Its name rides RequestView.businessName. */
  businessId: string | null;
  /** The account the number named, for no_sub, so the card can say which one has no such sub-account. */
  accountName: string | null;
};
export interface BusinessSummaryItem { businessId: string; code: string; name: string; inCents: number; outCents: number }
export interface BusinessSummary { items: BusinessSummaryItem[] }
export interface AccountInput { name: string; phone?: string | null; note?: string | null }
/** One past holder of a number, for "Past holders of this number". */
export interface HistoryEntry { name: string; phone: string | null; level: 'business' | 'account' | 'sub_account'; createdAt: string; deletedAt: string; deletedBy: string | null }
/** The random draw, injected: tests pin the number a run produces without stubbing the database. */
export type Rng = (maxExclusive: number) => number;

/** Daraja refuses an AccountReference longer than twelve digits, so Studio never mints one. */
export const MAX_NUMBER_DIGITS = 12;
/** Account and sub-account numbers start at three digits; a leading 9 is how a width is written. */
export const FIRST_WIDTH = 3;
/** Every width holds 900 numbers: the leading 9s, then a first digit of 0-8 and two more digits. */
export const WIDTH_CAPACITY = 900;
/** How many draws one width gets before it is treated as full and the width grows by one. */
const DRAWS_PER_WIDTH = 20;
/** How long a reissued number keeps explaining itself. */
const REISSUE_MEMORY_MONTHS = 12;

export interface BusinessesService {
  list(): Promise<{ items: BusinessView[]; lastUsedId: string | null }>;
  create(name: string, actor: Actor): Promise<BusinessView>;
  update(id: string, name: string, active: boolean, actor: Actor): Promise<BusinessView>;
  /** Delete a business. Refused while it still has accounts: their numbers are somebody's. */
  deleteBusiness(id: string, typedName: string, actor: Actor): Promise<void>;
  /** The accounts of one business, each with its live sub-accounts nested under it. */
  accounts(businessId: string, q?: string): Promise<AccountView[]>;
  addAccount(businessId: string, input: AccountInput, actor: Actor): Promise<AccountView>;
  /** A sub-account under an account: a room, a plot, a child's fees. Studio draws its number too. */
  addSubAccount(parentId: string, input: AccountInput, actor: Actor): Promise<AccountView>;
  updateAccount(id: string, input: AccountInput, actor: Actor): Promise<AccountView>;
  /** Delete an account or sub-account: the row goes, the number returns to the free pool. */
  deleteAccount(id: string, typedName: string, actor: Actor): Promise<void>;
  /** Every past holder of one number, newest first. */
  history(fullNumber: string): Promise<HistoryEntry[]>;
  /** The one-click fix on Money in: label the row, never move or change it. */
  assign(requestId: string, businessId: string, accountId: string | null, actor: Actor): Promise<RequestView>;
  summary(day?: string): Promise<BusinessSummary>;
  unmatched(limit?: number): Promise<UnmatchedPayment[]>;
}

interface BusinessRow { id: string; code: string; name: string; active: boolean; created_at: Date; account_count?: number }
interface AccountRow {
  id: string; business_id: string; parent_id: string | null; number: string; full_number: string;
  name: string; phone: string | null; note: string | null; created_at: Date;
}
interface WidthRow { id: string; scope_kind: 'accounts' | 'sub_accounts'; scope_id: string; width: number; capacity: number; used: number; closed_at: Date | null }
/** What one mint did, and the width change it caused, when it caused one. */
interface Minted {
  row: AccountRow;
  grew: { scopeKind: 'accounts' | 'sub_accounts'; scopeId: string; previousWidth: number; width: number } | null;
}

const UNIQUE_VIOLATION = '23505';
const isUnique = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
const COLS = 'id, business_id, parent_id, number, full_number, name, phone, note, created_at';
const WIDTH_COLS = 'id, scope_kind, scope_id, width, capacity, used, closed_at';
const NO_NUMBERS = 'This business has used every account number Studio can make. Delete an account you no longer need, then try again.';

function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

const toBusinessView = (r: BusinessRow, numbers: NumberWidth): BusinessView => ({
  id: r.id, code: r.code.trim(), name: r.name, active: r.active,
  accountCount: Number(r.account_count ?? 0), numbers, createdAt: r.created_at.toISOString(),
});

const toAccountView = (r: AccountRow, children: AccountView[] = [], previousHolder: PastHolder | null = null): AccountView => ({
  id: r.id, businessId: r.business_id, parentId: r.parent_id, number: r.number, fullNumber: r.full_number,
  name: r.name, phone: r.phone, note: r.note, createdAt: r.created_at.toISOString(),
  children, previousHolder,
});

/** The width a scope is on, and how much of it is live, counted from the rows themselves. */
async function widthReport(db: Db): Promise<Map<string, NumberWidth>> {
  const open = await db.query<{ scope_id: string; width: number; capacity: number }>(
    `SELECT scope_id, width, capacity FROM number_widths WHERE scope_kind='accounts' AND closed_at IS NULL`);
  const counts = await db.query<{ business_id: string; w: number; n: string }>(
    `SELECT business_id, char_length(number) AS w, count(*)::text AS n FROM accounts WHERE parent_id IS NULL GROUP BY 1, 2`);
  const out = new Map<string, NumberWidth>();
  for (const row of open) {
    const used = counts.filter((c) => c.business_id === row.scope_id && Number(c.w) === row.width)
      .reduce((sum, c) => sum + Number(c.n), 0);
    out.set(row.scope_id, { width: row.width, capacity: row.capacity, used });
  }
  // A business whose accounts were written before the tracker has no width row yet. It is on its
  // shortest width, and those rows are what is already used; the next mint opens the same row.
  for (const businessId of new Set(counts.map((c) => c.business_id))) {
    if (out.has(businessId)) continue;
    const mine = counts.filter((c) => c.business_id === businessId);
    const width = Math.min(...mine.map((c) => Number(c.w)));
    const used = mine.filter((c) => Number(c.w) === width).reduce((sum, c) => sum + Number(c.n), 0);
    out.set(businessId, { width, capacity: WIDTH_CAPACITY, used });
  }
  return out;
}

export function createBusinessesService(deps: { db: Db; settings: Settings; events: EventHub; egressIps?: string[]; rng?: Rng }): BusinessesService {
  const egressIps = deps.egressIps ?? [];
  const rng: Rng = deps.rng ?? ((max: number) => randomInt(max));

  async function businessRow(id: string): Promise<BusinessRow> {
    const [row] = await deps.db.query<BusinessRow>(
      `SELECT b.*, (SELECT count(*)::int FROM accounts a WHERE a.business_id = b.id) AS account_count
         FROM businesses b WHERE b.id = $1 AND b.org_id = $2`, [id, requireOrg()]);
    if (!row) throw new HttpError(404, 'not_found', 'That business does not exist.');
    return row;
  }

  async function accountRow(id: string): Promise<AccountRow> {
    const [row] = await deps.db.query<AccountRow>(`SELECT ${COLS} FROM accounts WHERE id = $1 AND org_id = $2`, [id, requireOrg()]);
    if (!row) throw new HttpError(404, 'not_found', 'That account does not exist.');
    return row;
  }

  /** The live accounts of one scope at one width — what the free pool is measured against. */
  const liveAt = async (c: PoolClient, businessId: string, parentId: string | null, width: number): Promise<number> => {
    const [row] = (await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts WHERE business_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND char_length(number)=$3`,
      [businessId, parentId, width])).rows;
    return Number(row.n);
  };

  /**
   * The lowest width with a free number, opening or reopening its tracker row. Null when nothing
   * fits. `fresh` says the row was created here — the only case that can be growth.
   */
  async function widthWithRoom(c: PoolClient, scopeKind: 'accounts' | 'sub_accounts', scopeId: string, businessId: string, parentId: string | null, base: number): Promise<{ row: WidthRow; fresh: boolean } | null> {
    for (let width = FIRST_WIDTH; base + width <= MAX_NUMBER_DIGITS; width++) {
      const live = await liveAt(c, businessId, parentId, width);
      if (live >= WIDTH_CAPACITY) {
        // Every number of this width is held, so the row says when it filled. It is not consulted to
        // decide anything — the live count is — but "closed" is what the owner sees and what a freed
        // number reopens.
        await c.query(`UPDATE number_widths SET used=$3, closed_at=COALESCE(closed_at, now()) WHERE scope_kind=$1 AND scope_id=$2 AND width=$4`, [scopeKind, scopeId, live, width]);
        continue;
      }
      const [row] = (await c.query<WidthRow>(
        `SELECT ${WIDTH_COLS} FROM number_widths WHERE scope_kind=$1 AND scope_id=$2 AND width=$3`, [scopeKind, scopeId, width])).rows;
      if (row) {
        // A width that was closed has room again: deleting freed a number, so it reopens and its
        // counter comes back to the live count.
        if (row.closed_at !== null || row.used !== live) {
          const { rows } = await c.query<WidthRow>(`UPDATE number_widths SET closed_at=NULL, used=$2 WHERE id=$1 RETURNING ${WIDTH_COLS}`, [row.id, live]);
          return rows[0] ? { row: rows[0], fresh: false } : null;
        }
        return { row, fresh: false };
      }
      const { rows } = await c.query<WidthRow>(
        `INSERT INTO number_widths(scope_kind, scope_id, width, used) VALUES ($1,$2,$3,$4) RETURNING ${WIDTH_COLS}`,
        [scopeKind, scopeId, width, live]);
      return rows[0] ? { row: rows[0], fresh: true } : null;
    }
    return null;
  }

  /**
   * One mint, under this business (and this parent) alone. The advisory lock is transaction-scoped,
   * so two Studio presses can never draw the same free number and both win: the second waits, then
   * sees the first row and draws again.
   *
   * The width chosen is the lowest one that still has a free number, counted from the live rows, so
   * a number freed by a delete is handed out again before any longer one is opened. A width that was
   * closed reopens when a number in it comes back, and only a width never opened before is growth.
   */
  async function mint(businessId: string, parent: { id: string; number: string; name: string } | null, input: AccountInput, actor: Actor): Promise<Minted> {
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const scopeKind = parent ? 'sub_accounts' as const : 'accounts' as const;
    const scopeId = parent ? parent.id : businessId;
    const base = FIRST_WIDTH + (parent ? parent.number.length : 0);
    return deps.db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['accounts:' + scopeId]);
      const [biz] = (await c.query<{ id: string }>(`SELECT id FROM businesses WHERE id=$1 AND org_id=$2`, [businessId, requireOrg()])).rows;
      if (!biz) throw new HttpError(404, 'not_found', 'That business does not exist.');
      const room = await widthWithRoom(c, scopeKind, scopeId, businessId, parent ? parent.id : null, base);
      if (!room) throw new HttpError(409, 'no_numbers_left', NO_NUMBERS);
      const open = room.row;
      // Growth is a width that did not exist before and is longer than the base: the numbers a payer
      // is told get longer. A reopened width, and the first width itself, are not growth.
      const grew = room.fresh && open.width > FIRST_WIDTH ? { scopeKind, scopeId, previousWidth: open.width - 1, width: open.width } : null;
      const used = await liveAt(c, businessId, parent ? parent.id : null, open.width);
      for (let draw = 0; draw < DRAWS_PER_WIDTH; draw++) {
        const candidate = '9'.repeat(open.width - FIRST_WIDTH) + String(rng(WIDTH_CAPACITY)).padStart(3, '0');
        const { rows } = await c.query<AccountRow>(
          `INSERT INTO accounts(business_id, parent_id, number, name, phone, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING ${COLS}`,
          [businessId, parent ? parent.id : null, candidate, input.name, phone, input.note ?? null, actor.personId]);
        if (rows[0]) {
          await c.query(`UPDATE number_widths SET used=$2 WHERE id=$1`, [open.id, used + 1]);
          return { row: rows[0], grew };
        }
      }
      // Twenty draws clashed in a width that still had room, which only a broken draw can do. Nothing
      // is written, and the person is told plainly rather than handed a number nobody drew.
      throw new HttpError(409, 'no_numbers_left', NO_NUMBERS);
    });
  }

  /** The audit row and the owner's line when a width opened for the first time. */
  async function announce(grew: NonNullable<Minted['grew']>, businessName: string, parent: { id: string; name: string } | null, actor: Actor) {
    await audit(deps.db, {
      personId: actor.personId, action: 'accounts.width_grew', target: grew.scopeId,
      after: { scope: grew.scopeKind, width: grew.width, previousWidth: grew.previousWidth }, ip: actor.ip,
    });
    await deps.events.publish('accounts.width_grew', {
      scope: grew.scopeKind, businessName,
      accountId: parent ? parent.id : null, accountName: parent ? parent.name : null,
      width: grew.width, previousWidth: grew.previousWidth,
    });
  }

  /** Who held this number before, within the last year, for one or many numbers at once. */
  async function previousHolders(fullNumbers: string[]): Promise<Map<string, PastHolder>> {
    if (fullNumbers.length === 0) return new Map();
    const rows = await deps.db.query<{ full_number: string; name: string; deleted_at: Date }>(
      `SELECT DISTINCT ON (full_number) full_number, name, deleted_at FROM number_history
        WHERE full_number = ANY($1) AND deleted_at > now() - make_interval(months => $2)
        ORDER BY full_number, deleted_at DESC`,
      [fullNumbers, REISSUE_MEMORY_MONTHS]);
    return new Map(rows.map((r) => [r.full_number, { name: r.name, until: r.deleted_at.toISOString() }]));
  }

  /** One number_history row per deleted account, and the digits come back to the pool. */
  async function recordAndDelete(c: PoolClient, rows: AccountRow[], businessCode: string, level: 'account' | 'sub_account', actor: Actor): Promise<void> {
    for (const r of rows) {
      await c.query(
        `INSERT INTO number_history(business_code, full_number, level, name, phone, created_at, deleted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [businessCode, r.full_number, level, r.name, r.phone, r.created_at, actor.personId]);
    }
    await c.query(`DELETE FROM accounts WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
  }

  return {
    async list() {
      const rows = await deps.db.query<BusinessRow>(
        `SELECT b.*, (SELECT count(*)::int FROM accounts a WHERE a.business_id = b.id) AS account_count
           FROM businesses b ORDER BY b.code`);
      const numbers = await widthReport(deps.db);
      const items = rows.map((r) => toBusinessView(r, numbers.get(r.id) ?? { width: FIRST_WIDTH, capacity: WIDTH_CAPACITY, used: 0 }));
      const last = await deps.settings.get('send.lastBusinessId');
      return { items, lastUsedId: last && items.some((b) => b.id === last) ? last : null };
    },

    // The lock is what makes "next free, lowest first" true when two people press Add at once: the
    // second waits, then sees the first row and takes the code after it.
    async create(name, actor) {
      try {
        const row = await deps.db.tx(async (c) => {
          await c.query(`SELECT pg_advisory_xact_lock(hashtext('businesses'))`);
          const [free] = (await c.query<{ code: string }>(
            `SELECT to_char(g, 'FM000') AS code FROM generate_series(0, 999) g
              WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.code = to_char(g, 'FM000')) ORDER BY g LIMIT 1`)).rows;
          if (!free) throw new HttpError(409, 'no_codes_left', 'All one thousand business codes are in use.');
          const { rows } = await c.query<BusinessRow>(
            `INSERT INTO businesses(code, name) VALUES ($1,$2) RETURNING *`, [free.code, name]);
          return rows[0];
        });
        await audit(deps.db, { personId: actor.personId, action: 'business.added', target: row.id, after: { code: row.code.trim(), name }, ip: actor.ip });
        return toBusinessView({ ...row, account_count: 0 }, { width: FIRST_WIDTH, capacity: WIDTH_CAPACITY, used: 0 });
      } catch (e) {
        if (isUnique(e)) throw new HttpError(409, 'name_taken', 'You already have a business with that name.');
        throw e;
      }
    },

    async update(id, name, active, actor) {
      const before = await businessRow(id);
      try {
        const [row] = await deps.db.query<BusinessRow>(
          `UPDATE businesses SET name=$2, active=$3, updated_at=now() WHERE id=$1 AND org_id=$4
           RETURNING *, (SELECT count(*)::int FROM accounts a WHERE a.business_id = businesses.id) AS account_count`,
          [id, name, active, requireOrg()]);
        await audit(deps.db, { personId: actor.personId, action: 'business.updated', target: id, before: { name: before.name, active: before.active }, after: { name, active }, ip: actor.ip });
        const numbers = await widthReport(deps.db);
        return toBusinessView(row, numbers.get(id) ?? { width: FIRST_WIDTH, capacity: WIDTH_CAPACITY, used: 0 });
      } catch (e) {
        if (isUnique(e)) throw new HttpError(409, 'name_taken', 'You already have a business with that name.');
        throw e;
      }
    },

    // A business may go only when nothing bears its code: an account number is somebody's, and the
    // digits would stop meaning that business the moment the code was handed out again.
    async deleteBusiness(id, typedName, actor) {
      const before = await businessRow(id);
      if (typedName.trim() !== before.name) throw new HttpError(400, 'name_mismatch', 'That is not the name of this business. Nothing was deleted.');
      if (Number(before.account_count ?? 0) > 0) {
        throw new HttpError(409, 'accounts_remain', 'This business still has accounts. Delete them first, then delete the business.');
      }
      await deps.db.tx(async (c) => {
        await c.query(
          `INSERT INTO number_history(business_code, full_number, level, name, phone, created_at, deleted_by)
           VALUES ($1::char(3), $1::text, 'business', $2, NULL, $3, $4)`,
          [before.code.trim(), before.name, before.created_at, actor.personId]);
        await c.query(`DELETE FROM number_widths WHERE scope_kind='accounts' AND scope_id=$1`, [id]);
        await c.query(`DELETE FROM businesses WHERE id=$1`, [id]);
      });
      await audit(deps.db, { personId: actor.personId, action: 'business.deleted', target: id, before: { code: before.code.trim(), name: before.name }, ip: actor.ip });
    },

    async accounts(businessId, q) {
      await businessRow(businessId);
      const rows = await deps.db.query<AccountRow>(`SELECT ${COLS} FROM accounts WHERE business_id=$1 ORDER BY number`, [businessId]);
      const needle = (q ?? '').trim().toLowerCase();
      const keep = new Set(rows.filter((r) => !needle
        || r.name.toLowerCase().includes(needle) || r.number.includes(needle) || r.full_number.includes(needle)).map((r) => r.id));
      // A search that finds a sub-account keeps its account in the answer, so the tree the page
      // draws is never a child without its parent.
      for (const r of rows) if (r.parent_id && keep.has(r.id)) keep.add(r.parent_id);
      const live = rows.filter((r) => keep.has(r.id));
      const holders = await previousHolders(live.map((r) => r.full_number));
      return live.filter((r) => r.parent_id === null)
        .map((r) => toAccountView(r, live.filter((k) => k.parent_id === r.id).map((k) => toAccountView(k, [], holders.get(k.full_number) ?? null)), holders.get(r.full_number) ?? null));
    },

    async addAccount(businessId, input, actor) {
      const business = await businessRow(businessId);
      const minted = await mint(businessId, null, input, actor);
      const view = toAccountView(minted.row);
      await audit(deps.db, { personId: actor.personId, action: 'account.added', target: view.id, after: { businessId, fullNumber: view.fullNumber, name: view.name }, ip: actor.ip });
      if (minted.grew) await announce(minted.grew, business.name, null, actor);
      return view;
    },

    async addSubAccount(parentId, input, actor) {
      const parent = await accountRow(parentId);
      if (parent.parent_id) throw new HttpError(400, 'too_deep', 'A sub-account under a sub-account is not allowed. Add it under the account instead.');
      const business = await businessRow(parent.business_id);
      const minted = await mint(parent.business_id, { id: parent.id, number: parent.number, name: parent.name }, input, actor);
      const view = toAccountView(minted.row);
      await audit(deps.db, { personId: actor.personId, action: 'account.added', target: view.id, after: { businessId: parent.business_id, parentId, fullNumber: view.fullNumber, name: view.name }, ip: actor.ip });
      if (minted.grew) await announce(minted.grew, business.name, { id: parent.id, name: parent.name }, actor);
      return view;
    },

    // A number is never edited and never re-pointed, so only the words around it can change. The
    // audit row records the name and the note and whether a phone was given — never the phone
    // number itself, which Studio does not write into the log.
    async updateAccount(id, input, actor) {
      const before = await accountRow(id);
      const phone = input.phone ? normalizePhone(input.phone) : null;
      const [row] = await deps.db.query<AccountRow>(
        `UPDATE accounts SET name=$2, phone=$3, note=$4 WHERE id=$1 AND org_id=$5 RETURNING ${COLS}`,
        [id, input.name, phone, input.note ?? null, requireOrg()]);
      await audit(deps.db, {
        personId: actor.personId, action: 'account.edited', target: id,
        before: { name: before.name, note: before.note, phone: before.phone !== null },
        after: { name: input.name, note: input.note ?? null, phone: phone !== null }, ip: actor.ip,
      });
      return toAccountView(row);
    },

    async deleteAccount(id, typedName, actor) {
      const before = await accountRow(id);
      if (typedName.trim() !== before.name) throw new HttpError(400, 'name_mismatch', 'That is not the name of this account. Nothing was deleted.');
      const [business] = await deps.db.query<{ code: string; name: string }>(`SELECT code, name FROM businesses WHERE id=$1`, [before.business_id]);
      const code = business?.code.trim() ?? '';
      const level = before.parent_id === null ? 'account' as const : 'sub_account' as const;
      let alsoDeleted = 0;
      await deps.db.tx(async (c) => {
        // The sub-accounts go with their account, so their numbers are recorded too, before the
        // cascade takes them.
        const children = level === 'account'
          ? (await c.query<AccountRow>(`SELECT ${COLS} FROM accounts WHERE parent_id=$1 FOR UPDATE`, [id])).rows
          : [];
        alsoDeleted = children.length;
        await recordAndDelete(c, children, code, 'sub_account', actor);
        await recordAndDelete(c, [before], code, level, actor);
        // The scope's tracker rows have no meaning without their rows: the numbers are free again,
        // and the next mint opens the width it needs.
        await c.query(`DELETE FROM number_widths WHERE scope_kind='accounts' AND scope_id=$1`, [before.business_id]);
        if (level === 'account') await c.query(`DELETE FROM number_widths WHERE scope_kind='sub_accounts' AND scope_id=$1`, [id]);
      });
      await audit(deps.db, {
        personId: actor.personId, action: 'account.deleted', target: id,
        before: { name: before.name, fullNumber: before.full_number, subAccountsDeleted: alsoDeleted }, ip: actor.ip,
      });
    },

    async history(fullNumber) {
      const rows = await deps.db.query<{ name: string; phone: string | null; level: HistoryEntry['level']; created_at: Date; deleted_at: Date; deleted_by: string | null }>(
        `SELECT name, phone, level, created_at, deleted_at, deleted_by FROM number_history
          WHERE full_number = $1 ORDER BY deleted_at DESC`, [fullNumber]);
      return rows.map((r) => ({ name: r.name, phone: r.phone, level: r.level, createdAt: r.created_at.toISOString(), deletedAt: r.deleted_at.toISOString(), deletedBy: r.deleted_by }));
    },

    async assign(requestId, businessId, accountId, actor) {
      const [row] = await deps.db.query<{ id: string; type: string; business_id: string | null; account_id: string | null }>(
        `SELECT id, type, business_id, account_id FROM requests WHERE id=$1 AND org_id=$2`, [requestId, requireOrg()]);
      if (!row) throw new HttpError(404, 'not_found', 'That payment does not exist.');
      if (row.type !== 'c2b') throw new HttpError(400, 'not_c2b', 'Only a customer payment can be labelled with a business.');
      const business = await businessRow(businessId);
      let fullNumber: string | null = null;
      if (accountId) {
        const [account] = await deps.db.query<{ id: string; full_number: string }>(
          `SELECT id, full_number FROM accounts WHERE id=$1 AND business_id=$2`, [accountId, businessId]);
        if (!account) throw new HttpError(400, 'unknown_account', 'That account is not in this business.');
        fullNumber = account.full_number;
      }
      await deps.db.query(`UPDATE requests SET business_id=$2, account_id=$3 WHERE id=$1`, [requestId, businessId, accountId]);
      await audit(deps.db, {
        personId: actor.personId, action: 'money_in.assigned', target: requestId,
        before: { businessId: row.business_id, accountId: row.account_id },
        after: { businessId, code: business.code.trim(), accountId, fullNumber }, ip: actor.ip,
      });
      const view = await getRequest(deps.db, requestId, egressIps);
      if (!view) throw new HttpError(404, 'not_found', 'That payment does not exist.');
      return view;
    },

    async summary(day) {
      const [d] = await deps.db.query<{ day: string }>(`SELECT COALESCE($1::date, (now() AT TIME ZONE 'Africa/Nairobi')::date)::text AS day`, [day ?? null]);
      const rows = await deps.db.query<{ business_id: string; code: string; name: string; in_cents: string; out_cents: string }>(
        `SELECT b.id AS business_id, b.code, b.name,
             COALESCE(SUM(CASE WHEN r.type = 'c2b' AND r.status = 'completed' THEN r.amount_cents ELSE 0 END), 0)::bigint AS in_cents,
             COALESCE(SUM(CASE WHEN r.type = ANY($2) AND r.status IN ('sent','completed') THEN r.amount_cents ELSE 0 END), 0)::bigint AS out_cents
           FROM businesses b
           LEFT JOIN requests r ON r.business_id = b.id AND (r.created_at AT TIME ZONE 'Africa/Nairobi')::date = $1::date
           GROUP BY b.id, b.code, b.name ORDER BY b.code`,
        [d.day, MONEY_TYPES]);
      return {
        items: rows.map((r) => ({ businessId: r.business_id, code: r.code.trim(), name: r.name, inCents: Number(r.in_cents), outCents: Number(r.out_cents) })),
      };
    },

    // Unmatched is decided by the same parser the callback uses, read again now: a row a human has
    // since labelled drops off the list on its own. Nothing here changes a row; the fix is an assign.
    async unmatched(limit = 50) {
      const index = await loadIndex(deps.db);
      if (index.businesses.length === 0) return [];
      const rows = await deps.db.query<{ id: string; account_reference: string | null }>(
        `SELECT id, account_reference FROM requests
          WHERE type='c2b' AND status='completed' AND account_id IS NULL
          ORDER BY created_at DESC LIMIT $1`, [limit]);
      const out: UnmatchedPayment[] = [];
      for (const r of rows) {
        const match = parseAccount(r.account_reference, index.businesses, index.accounts);
        if (match.kind !== 'unmatched') continue;
        const view = await getRequest(deps.db, r.id, egressIps);
        if (!view) continue;
        if (match.reason === 'no_business' && view.businessId !== null) continue;
        out.push({ ...view, reason: match.reason, businessId: match.businessId, accountName: match.accountName });
      }
      return out;
    },
  };
}
