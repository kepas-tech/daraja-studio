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
 * Brief 2, item 1: the businesses one paybill serves, and the account numbers Studio mints for
 * each. Three levels, digits only — a business code, a customer account, an optional account under
 * it — and every digit is Studio's to choose, so no form has a number box and no route accepts
 * one. A number carries its own width (see match.ts), so a payer's digits can never route to the
 * wrong account. Nothing here reads or writes money: an assign only labels a row a human has read.
 */

export interface Actor { personId: string; ip: string }
/** The open width of a scope, for the plain line the Businesses page shows. */
export interface NumberWidth { width: number; capacity: number; used: number }
export interface BusinessView { id: string; code: string; name: string; active: boolean; accountCount: number; numbers: NumberWidth; createdAt: string }
export interface AccountView {
  id: string; businessId: string; parentId: string | null; number: string; fullNumber: string;
  name: string; phone: string | null; note: string | null; createdAt: string; retiredAt: string | null;
  /** Live accounts under this customer, in number order; always empty for an account that is itself under one. */
  children: AccountView[];
}
/**
 * One money-in row that needs a human decision: the ordinary RequestView the page already renders,
 * plus why it is here. Contract fixed with the web side — flat fields, no nested business object.
 */
export type UnmatchedPayment = RequestView & {
  reason: UnmatchedReason;
  /** The known business, for the reasons that name one; null for no_business. Its name rides RequestView.businessName. */
  businessId: string | null;
  /** The customer the number named, for no_sub, so the card can say which one has no such account. */
  customerName: string | null;
};
export interface BusinessSummaryItem { businessId: string; code: string; name: string; inCents: number; outCents: number }
export interface BusinessSummary { items: BusinessSummaryItem[] }
export interface AccountInput { name: string; phone?: string | null; note?: string | null }
/** The random draw, injected: tests pin the number a run produces without stubbing the database. */
export type Rng = (maxExclusive: number) => number;

/** Daraja refuses an AccountReference longer than twelve digits, so Studio never mints one. */
export const MAX_NUMBER_DIGITS = 12;
/** Customer and sub-account numbers start at three digits; a leading 9 is how a width is written. */
export const FIRST_WIDTH = 3;
/** Every width holds 900 numbers: the leading 9s, then a first digit of 0-8 and two more digits. */
export const WIDTH_CAPACITY = 900;
/** How many draws one width gets before it is treated as full and the width grows by one. */
const DRAWS_PER_WIDTH = 20;

export interface BusinessesService {
  list(): Promise<{ items: BusinessView[]; lastUsedId: string | null }>;
  create(name: string, code: string | undefined, actor: Actor): Promise<BusinessView>;
  update(id: string, name: string, active: boolean, actor: Actor): Promise<BusinessView>;
  /** The customer accounts of one business, each with its live accounts nested under it. */
  accounts(businessId: string, q?: string): Promise<AccountView[]>;
  addAccount(businessId: string, input: AccountInput, actor: Actor): Promise<AccountView>;
  /** An account under a customer: a room, a plot, a child's fees. Studio mints its number too. */
  addChild(parentId: string, input: AccountInput, actor: Actor): Promise<AccountView>;
  updateAccount(id: string, input: AccountInput, actor: Actor): Promise<AccountView>;
  retireAccount(id: string, actor: Actor): Promise<void>;
  /** The one-click fix on Money in: label the row, never move or change it. */
  assign(requestId: string, businessId: string, accountId: string | null, actor: Actor): Promise<RequestView>;
  summary(day?: string): Promise<BusinessSummary>;
  unmatched(limit?: number): Promise<UnmatchedPayment[]>;
}

interface BusinessRow { id: string; code: string; name: string; active: boolean; created_at: Date; account_count?: number }
interface AccountRow {
  id: string; business_id: string; parent_id: string | null; number: string; full_number: string;
  name: string; phone: string | null; note: string | null; created_at: Date; retired_at: Date | null;
}
interface WidthRow { id: string; scope_kind: 'customers' | 'sub_accounts'; scope_id: string; width: number; capacity: number; used: number }
/** What one mint did, and the width change it caused, when it caused one. */
interface Minted {
  row: AccountRow;
  grew: { scopeKind: 'customers' | 'sub_accounts'; scopeId: string; previousWidth: number; width: number } | null;
}

const UNIQUE_VIOLATION = '23505';
const isUnique = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;
const COLS = 'id, business_id, parent_id, number, full_number, name, phone, note, created_at, retired_at';
const WIDTH_COLS = 'id, scope_kind, scope_id, width, capacity, used';
const NO_NUMBERS = 'This business has used every account number Studio can make. Retire an account you no longer need, then try again.';

function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

const toBusinessView = (r: BusinessRow, numbers: NumberWidth): BusinessView => ({
  id: r.id, code: r.code.trim(), name: r.name, active: r.active,
  accountCount: Number(r.account_count ?? 0), numbers, createdAt: r.created_at.toISOString(),
});

const toAccountView = (r: AccountRow, children: AccountView[] = []): AccountView => ({
  id: r.id, businessId: r.business_id, parentId: r.parent_id, number: r.number, fullNumber: r.full_number,
  name: r.name, phone: r.phone, note: r.note, createdAt: r.created_at.toISOString(),
  retiredAt: r.retired_at ? r.retired_at.toISOString() : null, children,
});

/** The width a scope is on, and how much of it is used, counted from the rows themselves. */
async function widthReport(db: Db): Promise<Map<string, NumberWidth>> {
  const open = await db.query<{ scope_id: string; width: number; capacity: number }>(
    `SELECT scope_id, width, capacity FROM number_widths WHERE scope_kind='customers' AND closed_at IS NULL`);
  const counts = await db.query<{ business_id: string; w: number; n: string }>(
    `SELECT business_id, char_length(number) AS w, count(*)::text AS n FROM accounts WHERE parent_id IS NULL GROUP BY 1, 2`);
  const out = new Map<string, NumberWidth>();
  for (const row of open) {
    const used = counts.filter((c) => c.business_id === row.scope_id && Number(c.w) === row.width)
      .reduce((sum, c) => sum + Number(c.n), 0);
    out.set(row.scope_id, { width: row.width, capacity: row.capacity, used });
  }
  return out;
}

export function createBusinessesService(deps: { db: Db; settings: Settings; events: EventHub; egressIps?: string[]; rng?: Rng }): BusinessesService {
  const egressIps = deps.egressIps ?? [];
  const rng: Rng = deps.rng ?? ((max: number) => randomInt(max));

  async function businessRow(id: string): Promise<BusinessRow> {
    const [row] = await deps.db.query<BusinessRow>(
      `SELECT b.*, (SELECT count(*)::int FROM accounts a WHERE a.business_id = b.id AND a.retired_at IS NULL) AS account_count
         FROM businesses b WHERE b.id = $1 AND b.org_id = $2`, [id, requireOrg()]);
    if (!row) throw new HttpError(404, 'not_found', 'That business does not exist.');
    return row;
  }

  async function accountRow(id: string): Promise<AccountRow> {
    const [row] = await deps.db.query<AccountRow>(`SELECT ${COLS} FROM accounts WHERE id = $1 AND org_id = $2`, [id, requireOrg()]);
    if (!row) throw new HttpError(404, 'not_found', 'That account does not exist.');
    return row;
  }

  const countOfWidth = async (c: PoolClient, businessId: string, parentId: string | null, width: number): Promise<number> => {
    const [row] = (await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts WHERE business_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND char_length(number)=$3`,
      [businessId, parentId, width])).rows;
    return Number(row.n);
  };

  /** The open width row of a scope, opening width 3 — or the next after the closed ones — when none is open. */
  async function openWidth(c: PoolClient, scopeKind: 'customers' | 'sub_accounts', scopeId: string, base: number): Promise<WidthRow | null> {
    const [open] = (await c.query<WidthRow>(
      `SELECT ${WIDTH_COLS} FROM number_widths WHERE scope_kind=$1 AND scope_id=$2 AND closed_at IS NULL ORDER BY width DESC LIMIT 1`,
      [scopeKind, scopeId])).rows;
    if (open) return open;
    const [last] = (await c.query<{ w: number | null }>(
      `SELECT MAX(width) AS w FROM number_widths WHERE scope_kind=$1 AND scope_id=$2`, [scopeKind, scopeId])).rows;
    const width = Number(last.w ?? FIRST_WIDTH - 1) + 1;
    if (base + width > MAX_NUMBER_DIGITS) return null;
    const { rows } = await c.query<WidthRow>(
      `INSERT INTO number_widths(scope_kind, scope_id, width) VALUES ($1,$2,$3) RETURNING ${WIDTH_COLS}`,
      [scopeKind, scopeId, width]);
    return rows[0] ?? null;
  }

  /** Close a full width and open the next one. Null when the next width would not fit in twelve digits. */
  async function openNext(c: PoolClient, open: WidthRow, base: number): Promise<WidthRow | null> {
    await c.query(`UPDATE number_widths SET closed_at=now() WHERE id=$1 AND closed_at IS NULL`, [open.id]);
    const width = open.width + 1;
    if (base + width > MAX_NUMBER_DIGITS) return null;
    const { rows } = await c.query<WidthRow>(
      `INSERT INTO number_widths(scope_kind, scope_id, width) VALUES ($1,$2,$3) RETURNING ${WIDTH_COLS}`,
      [open.scope_kind, open.scope_id, width]);
    return rows[0] ?? null;
  }

  /**
   * One mint, under this business (and this parent) alone. The advisory lock is transaction-scoped,
   * so two Studio presses can never draw the same free number and both win: the second waits, then
   * sees the first row and draws again.
   *
   * The open width row is the authority on how many numbers are left, and its counter is reconciled
   * with the rows themselves on every mint — a number written by a restore or a hand-run script still
   * counts as used, and a retired one never comes back. At 900 used the width is closed and the next
   * is opened, which is the moment the owner hears about.
   */
  async function mint(businessId: string, parent: { id: string; number: string; name: string } | null, input: AccountInput, actor: Actor): Promise<Minted> {
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const scopeKind = parent ? 'sub_accounts' as const : 'customers' as const;
    const scopeId = parent ? parent.id : businessId;
    const base = FIRST_WIDTH + (parent ? parent.number.length : 0);
    return deps.db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['accounts:' + scopeId]);
      const [biz] = (await c.query<{ id: string }>(`SELECT id FROM businesses WHERE id=$1 AND org_id=$2`, [businessId, requireOrg()])).rows;
      if (!biz) throw new HttpError(404, 'not_found', 'That business does not exist.');
      let grew: Minted['grew'] = null;
      for (;;) {
        const open = await openWidth(c, scopeKind, scopeId, base);
        if (!open) throw new HttpError(409, 'no_numbers_left', NO_NUMBERS);
        const used = await countOfWidth(c, businessId, parent ? parent.id : null, open.width);
        if (used !== open.used) await c.query(`UPDATE number_widths SET used=$2 WHERE id=$1`, [open.id, used]);
        if (used < open.capacity) {
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
        }
        const next = await openNext(c, open, base);
        if (!next) throw new HttpError(409, 'no_numbers_left', NO_NUMBERS);
        grew = { scopeKind, scopeId, previousWidth: open.width, width: next.width };
      }
    });
  }

  /** The audit row and the owner's line when a width grew. Never part of the mint's transaction. */
  async function announce(grew: NonNullable<Minted['grew']>, businessId: string, businessName: string, parent: { id: string; name: string } | null, actor: Actor) {
    await audit(deps.db, {
      personId: actor.personId, action: 'accounts.width_grew', target: grew.scopeId,
      after: { scope: grew.scopeKind, width: grew.width, previousWidth: grew.previousWidth }, ip: actor.ip,
    });
    await deps.events.publish('accounts.width_grew', {
      scope: grew.scopeKind, businessId, businessName,
      accountId: parent ? parent.id : null, accountName: parent ? parent.name : null,
      width: grew.width, previousWidth: grew.previousWidth,
    });
  }

  return {
    async list() {
      const rows = await deps.db.query<BusinessRow>(
        `SELECT b.*, (SELECT count(*)::int FROM accounts a WHERE a.business_id = b.id AND a.retired_at IS NULL) AS account_count
           FROM businesses b ORDER BY b.code`);
      const numbers = await widthReport(deps.db);
      const items = rows.map((r) => toBusinessView(r, numbers.get(r.id) ?? { width: FIRST_WIDTH, capacity: WIDTH_CAPACITY, used: 0 }));
      const last = await deps.settings.get('send.lastBusinessId');
      return { items, lastUsedId: last && items.some((b) => b.id === last) ? last : null };
    },

    async create(name, code, actor) {
      let chosen = code;
      if (!chosen) {
        const [free] = await deps.db.query<{ code: string }>(
          `SELECT to_char(g, 'FM000') AS code FROM generate_series(0, 999) g
            WHERE NOT EXISTS (SELECT 1 FROM businesses b WHERE b.code = to_char(g, 'FM000')) ORDER BY g LIMIT 1`);
        if (!free) throw new HttpError(409, 'no_codes_left', 'All one thousand business codes are in use.');
        chosen = free.code;
      }
      try {
        const [row] = await deps.db.query<BusinessRow>(
          `INSERT INTO businesses(code, name) VALUES ($1,$2) RETURNING *`, [chosen, name]);
        await audit(deps.db, { personId: actor.personId, action: 'business.added', target: row.id, after: { code: chosen.trim(), name }, ip: actor.ip });
        return toBusinessView({ ...row, account_count: 0 }, { width: FIRST_WIDTH, capacity: WIDTH_CAPACITY, used: 0 });
      } catch (e) {
        if (isUnique(e)) {
          // The two unique indexes are the code and the name; the constraint name says which.
          const constraint = String((e as { constraint?: string }).constraint ?? '');
          if (constraint.includes('name')) throw new HttpError(409, 'name_taken', 'You already have a business with that name.');
          throw new HttpError(409, 'code_taken', 'That business code is already in use. Pick another.');
        }
        throw e;
      }
    },

    async update(id, name, active, actor) {
      const before = await businessRow(id);
      try {
        const [row] = await deps.db.query<BusinessRow>(
          `UPDATE businesses SET name=$2, active=$3, updated_at=now() WHERE id=$1 AND org_id=$4
           RETURNING *, (SELECT count(*)::int FROM accounts a WHERE a.business_id = businesses.id AND a.retired_at IS NULL) AS account_count`,
          [id, name, active, requireOrg()]);
        await audit(deps.db, { personId: actor.personId, action: 'business.updated', target: id, before: { name: before.name, active: before.active }, after: { name, active }, ip: actor.ip });
        const numbers = await widthReport(deps.db);
        return toBusinessView(row, numbers.get(id) ?? { width: FIRST_WIDTH, capacity: WIDTH_CAPACITY, used: 0 });
      } catch (e) {
        if (isUnique(e)) throw new HttpError(409, 'name_taken', 'You already have a business with that name.');
        throw e;
      }
    },

    async accounts(businessId, q) {
      await businessRow(businessId);
      const rows = await deps.db.query<AccountRow>(`SELECT ${COLS} FROM accounts WHERE business_id=$1 AND retired_at IS NULL ORDER BY number`, [businessId]);
      const needle = (q ?? '').trim().toLowerCase();
      const keep = new Set(rows.filter((r) => !needle
        || r.name.toLowerCase().includes(needle) || r.number.includes(needle) || r.full_number.includes(needle)).map((r) => r.id));
      // A search that finds an account under a customer keeps its customer in the answer, so the
      // tree the page draws is never a child without its parent.
      for (const r of rows) if (r.parent_id && keep.has(r.id)) keep.add(r.parent_id);
      const live = rows.filter((r) => keep.has(r.id));
      return live.filter((r) => r.parent_id === null)
        .map((r) => toAccountView(r, live.filter((k) => k.parent_id === r.id).map((k) => toAccountView(k))));
    },

    async addAccount(businessId, input, actor) {
      const business = await businessRow(businessId);
      const minted = await mint(businessId, null, input, actor);
      const view = toAccountView(minted.row);
      await audit(deps.db, { personId: actor.personId, action: 'account.added', target: view.id, after: { businessId, fullNumber: view.fullNumber, name: view.name }, ip: actor.ip });
      if (minted.grew) await announce(minted.grew, businessId, business.name, null, actor);
      return view;
    },

    async addChild(parentId, input, actor) {
      const parent = await accountRow(parentId);
      if (parent.retired_at) throw new HttpError(409, 'retired', 'That account is retired. Add the account under a live customer.');
      if (parent.parent_id) throw new HttpError(400, 'too_deep', 'An account under an account is not allowed. Add it under the customer instead.');
      const business = await businessRow(parent.business_id);
      const minted = await mint(parent.business_id, { id: parent.id, number: parent.number, name: parent.name }, input, actor);
      const view = toAccountView(minted.row);
      await audit(deps.db, { personId: actor.personId, action: 'account.added', target: view.id, after: { businessId: parent.business_id, parentId, fullNumber: view.fullNumber, name: view.name }, ip: actor.ip });
      if (minted.grew) await announce(minted.grew, parent.business_id, business.name, { id: parent.id, name: parent.name }, actor);
      return view;
    },

    // A number is never edited and never re-pointed, so only the words around it can change. The
    // audit row records the name and the note and whether a phone was given — never the phone
    // number itself, which Studio does not write into the log.
    async updateAccount(id, input, actor) {
      const before = await accountRow(id);
      const phone = input.phone ? normalizePhone(input.phone) : null;
      const [row] = await deps.db.query<AccountRow>(
        `UPDATE accounts SET name=$2, phone=$3, note=$4, updated_at=now() WHERE id=$1 AND org_id=$5 RETURNING ${COLS}`,
        [id, input.name, phone, input.note ?? null, requireOrg()]);
      await audit(deps.db, {
        personId: actor.personId, action: 'account.edited', target: id,
        before: { name: before.name, note: before.note, phone: before.phone !== null },
        after: { name: input.name, note: input.note ?? null, phone: phone !== null }, ip: actor.ip,
      });
      return toAccountView(row);
    },

    async retireAccount(id, actor) {
      const before = await accountRow(id);
      const rows = await deps.db.query<{ id: string }>(
        `UPDATE accounts SET retired_at=now(), updated_at=now() WHERE retired_at IS NULL AND (id=$1 OR parent_id=$1) RETURNING id`, [id]);
      await audit(deps.db, {
        personId: actor.personId, action: 'account.retired', target: id,
        after: { fullNumber: before.full_number, alsoRetired: Math.max(0, rows.length - 1) }, ip: actor.ip,
      });
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
          `SELECT id, full_number FROM accounts WHERE id=$1 AND business_id=$2 AND retired_at IS NULL`, [accountId, businessId]);
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
             -- Out counts a send Safaricom accepted ('sent') as well as one confirmed paid
             -- ('completed'): a request the operator just made is money on its way. 'unknown' is
             -- deliberately left out — Studio does not yet know whether that money left.
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
    // since labelled, or whose number has since been retired, drops off the list on its own. Nothing
    // here changes a row; the page's fix is an assign.
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
        // Somebody has already said which business a code nobody owns belongs to. That question is
        // answered, and the account question was never answerable from the digits, so the row leaves
        // the list rather than coming back for ever.
        if (match.reason === 'no_business' && view.businessId !== null) continue;
        out.push({ ...view, reason: match.reason, businessId: match.businessId, customerName: match.customerName });
      }
      return out;
    },
  };
}
