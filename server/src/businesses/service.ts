import { normalizePhone } from '@kepas/daraja-js';
import type { PoolClient } from 'pg';
import { currentOrgId, type Db } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { Settings } from '../settings/store.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { getRequest, type RequestView } from '../money_out/reads.js';
import { MONEY_TYPES } from '../money_out/registry.js';

/**
 * Feature 2: the businesses one paybill serves, and the customer numbers Studio mints for each.
 * The three-digit code in front of an account number decides whose money it is; nothing here reads
 * or writes money, and an assign only labels a row a human has looked at.
 */

export interface Actor { personId: string; ip: string }
export interface BusinessView { id: string; code: string; name: string; active: boolean; customerCount: number; createdAt: string }
export interface CustomerView {
  id: string; businessId: string; number: number; display: string; accountNumber: string;
  name: string; phone: string | null; note: string | null; createdAt: string;
}
/**
 * One money-in row that needs a human decision: the ordinary RequestView the page already renders,
 * plus why it is here. Contract fixed with the web side — flat fields, no nested business object.
 */
export type UnmatchedPayment = RequestView & {
  reason: 'no_business' | 'no_customer';
  /** The known business, for no_customer; null for no_business. The name rides RequestView.businessName. */
  businessId: string | null;
  /** The digits the payer typed after the code, for no_customer; null for no_business. */
  customerNumber: number | null;
};
export interface BusinessSummaryItem { businessId: string; code: string; name: string; inCents: number; outCents: number }
export interface BusinessSummary { items: BusinessSummaryItem[] }
export interface CustomerInput { name: string; phone?: string | null; note?: string | null }

export interface BusinessesService {
  list(): Promise<{ items: BusinessView[]; lastUsedId: string | null }>;
  create(name: string, code: string | undefined, actor: Actor): Promise<BusinessView>;
  update(id: string, name: string, active: boolean, actor: Actor): Promise<BusinessView>;
  customers(businessId: string, q?: string): Promise<CustomerView[]>;
  addCustomer(businessId: string, input: CustomerInput, actor: Actor): Promise<CustomerView>;
  /** The number the payer already typed, taken as this customer's number. 409 when it is used. */
  claimCustomer(businessId: string, number: number, input: CustomerInput, actor: Actor): Promise<CustomerView>;
  updateCustomer(id: string, input: CustomerInput, actor: Actor): Promise<CustomerView>;
  retireCustomer(id: string, actor: Actor): Promise<void>;
  /** The one-click fix on Money in: label the row, never move or change it. */
  assign(requestId: string, businessId: string, customerId: string | null, actor: Actor): Promise<RequestView>;
  summary(day?: string): Promise<BusinessSummary>;
  unmatched(limit?: number): Promise<UnmatchedPayment[]>;
}

interface BusinessRow { id: string; code: string; name: string; active: boolean; created_at: Date; customer_count?: number }
interface CustomerRow { id: string; business_id: string; number: number; name: string; phone: string | null; note: string | null; created_at: Date; code: string }

const UNIQUE_VIOLATION = '23505';
const isUnique = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION;

/** Three digits, and never padded past three: 7 shows as 007, 1000 shows as 1000. */
export const displayNumber = (n: number) => String(n).padStart(3, '0');
export const accountNumberOf = (code: string, n: number) => code + displayNumber(n);

function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

const toBusinessView = (r: BusinessRow): BusinessView => ({
  id: r.id, code: r.code.trim(), name: r.name, active: r.active,
  customerCount: Number(r.customer_count ?? 0), createdAt: r.created_at.toISOString(),
});

const toCustomerView = (r: CustomerRow): CustomerView => ({
  id: r.id, businessId: r.business_id, number: Number(r.number), display: displayNumber(Number(r.number)),
  accountNumber: accountNumberOf(r.code.trim(), Number(r.number)),
  name: r.name, phone: r.phone, note: r.note, createdAt: r.created_at.toISOString(),
});

/** The digits a payer typed after the business code, when there are any. Null means "the business". */
function typedCustomerNumber(reference: string, code: string, businessCount: number): number | null {
  const ref = reference.trim();
  if (ref.length > code.length && ref.startsWith(code)) {
    const rest = ref.slice(code.length);
    return /^[0-9]+$/.test(rest) ? Number(rest) : null;
  }
  if (businessCount === 1 && ref !== code && /^[0-9]+$/.test(ref)) return Number(ref);
  return null;
}

export function createBusinessesService(deps: { db: Db; settings: Settings; events: EventHub; egressIps?: string[] }): BusinessesService {
  const egressIps = deps.egressIps ?? [];
  const CUSTOMER_SELECT = `SELECT c.id, c.business_id, c.number, c.name, c.phone, c.note, c.created_at, b.code
    FROM customers c JOIN businesses b ON b.id = c.business_id`;

  async function businessRow(id: string): Promise<BusinessRow> {
    const [row] = await deps.db.query<BusinessRow>(
      `SELECT b.*, (SELECT count(*)::int FROM customers c WHERE c.business_id = b.id AND c.deleted_at IS NULL) AS customer_count
         FROM businesses b WHERE b.id = $1 AND b.org_id = $2`, [id, requireOrg()]);
    if (!row) throw new HttpError(404, 'not_found', 'That business does not exist.');
    return row;
  }

  /** Every mint runs under the business's own advisory lock, so two Studio presses cannot share a number. */
  async function insertCustomer(c: PoolClient, businessId: string, number: number, input: CustomerInput, actor: Actor): Promise<CustomerRow> {
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const { rows } = await c.query<CustomerRow>(
      `INSERT INTO customers(business_id, number, name, phone, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, business_id, number, name, phone, note, created_at,
         (SELECT code FROM businesses WHERE id = $1) AS code`,
      [businessId, number, input.name, phone, input.note ?? null, actor.personId]);
    return rows[0];
  }

  async function mint(businessId: string, input: CustomerInput, actor: Actor, fixed?: number): Promise<CustomerView> {
    try {
      const row = await deps.db.tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`customers:` + businessId]);
        const [biz] = (await c.query<{ id: string }>(`SELECT id FROM businesses WHERE id=$1 AND org_id=$2`, [businessId, requireOrg()])).rows;
        if (!biz) throw new HttpError(404, 'not_found', 'That business does not exist.');
        let number = fixed;
        if (number === undefined) {
          const [next] = (await c.query<{ next: string }>(`SELECT COALESCE(MAX(number) + 1, 0)::text AS next FROM customers WHERE business_id=$1`, [businessId])).rows;
          number = Number(next.next);
        }
        return insertCustomer(c, businessId, number, input, actor);
      });
      return toCustomerView(row);
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'number_taken', 'That customer number is already used in this business.');
      throw e;
    }
  }

  async function customerRow(id: string): Promise<CustomerRow> {
    const [row] = await deps.db.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [id, requireOrg()]);
    if (!row) throw new HttpError(404, 'not_found', 'That customer does not exist.');
    return row;
  }

  return {
    async list() {
      const rows = await deps.db.query<BusinessRow>(
        `SELECT b.*, (SELECT count(*)::int FROM customers c WHERE c.business_id = b.id AND c.deleted_at IS NULL) AS customer_count
           FROM businesses b ORDER BY b.code`);
      const items = rows.map(toBusinessView);
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
        return toBusinessView({ ...row, customer_count: 0 });
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
           RETURNING *, (SELECT count(*)::int FROM customers c WHERE c.business_id = businesses.id AND c.deleted_at IS NULL) AS customer_count`,
          [id, name, active, requireOrg()]);
        await audit(deps.db, { personId: actor.personId, action: 'business.updated', target: id, before: { name: before.name, active: before.active }, after: { name, active }, ip: actor.ip });
        return toBusinessView(row);
      } catch (e) {
        if (isUnique(e)) throw new HttpError(409, 'name_taken', 'You already have a business with that name.');
        throw e;
      }
    },

    async customers(businessId, q) {
      await businessRow(businessId);
      const params: unknown[] = [businessId];
      let where = `c.business_id = $1 AND c.deleted_at IS NULL`;
      if (q) { params.push(`%` + q.replace(/[\\%_]/g, (ch) => `\\` + ch) + `%`); where += ` AND c.name ILIKE $2 ESCAPE '\\'`; }
      const rows = await deps.db.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE ${where} ORDER BY c.number`, params);
      return rows.map(toCustomerView);
    },

    async addCustomer(businessId, input, actor) {
      await businessRow(businessId);
      const view = await mint(businessId, input, actor);
      await audit(deps.db, { personId: actor.personId, action: 'customer.added', target: view.id, after: { businessId, number: view.number, accountNumber: view.accountNumber }, ip: actor.ip });
      return view;
    },

    async claimCustomer(businessId, number, input, actor) {
      await businessRow(businessId);
      const view = await mint(businessId, input, actor, number);
      await audit(deps.db, { personId: actor.personId, action: 'customer.added', target: view.id, after: { businessId, number: view.number, accountNumber: view.accountNumber, claimed: true }, ip: actor.ip });
      return view;
    },

    async updateCustomer(id, input, actor) {
      const before = await customerRow(id);
      const phone = input.phone ? normalizePhone(input.phone) : null;
      const [row] = await deps.db.query<CustomerRow>(
        `UPDATE customers c SET name=$2, phone=$3, note=$4, updated_at=now()
           FROM businesses b WHERE c.id=$1 AND b.id = c.business_id
           RETURNING c.id, c.business_id, c.number, c.name, c.phone, c.note, c.created_at, b.code`,
        [id, input.name, phone, input.note ?? null]);
      await audit(deps.db, { personId: actor.personId, action: 'customer.edited', target: id, before: { name: before.name, phone: before.phone, note: before.note }, after: { name: input.name, phone, note: input.note ?? null }, ip: actor.ip });
      return toCustomerView(row);
    },

    async retireCustomer(id, actor) {
      const before = await customerRow(id);
      await deps.db.query(`UPDATE customers SET deleted_at=now(), updated_at=now() WHERE id=$1 AND deleted_at IS NULL`, [id]);
      await audit(deps.db, { personId: actor.personId, action: 'customer.retired', target: id, after: { number: Number(before.number), accountNumber: accountNumberOf(before.code.trim(), Number(before.number)) }, ip: actor.ip });
    },

    async assign(requestId, businessId, customerId, actor) {
      const [row] = await deps.db.query<{ id: string; type: string; business_id: string | null; customer_id: string | null }>(
        `SELECT id, type, business_id, customer_id FROM requests WHERE id=$1 AND org_id=$2`, [requestId, requireOrg()]);
      if (!row) throw new HttpError(404, 'not_found', 'That payment does not exist.');
      if (row.type !== 'c2b') throw new HttpError(400, 'not_c2b', 'Only a customer payment can be labelled with a business.');
      const business = await businessRow(businessId);
      if (customerId) {
        const [customer] = await deps.db.query<{ id: string }>(
          `SELECT id FROM customers WHERE id=$1 AND business_id=$2 AND deleted_at IS NULL`, [customerId, businessId]);
        if (!customer) throw new HttpError(400, 'unknown_customer', 'That customer is not in this business.');
      }
      await deps.db.query(`UPDATE requests SET business_id=$2, customer_id=$3 WHERE id=$1`, [requestId, businessId, customerId]);
      await audit(deps.db, {
        personId: actor.personId, action: 'money_in.assigned', target: requestId,
        before: { businessId: row.business_id, customerId: row.customer_id },
        after: { businessId, code: business.code.trim(), customerId }, ip: actor.ip,
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

    async unmatched(limit = 50) {
      const businesses = await deps.db.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM businesses ORDER BY code`);
      const rows = await deps.db.query<{ id: string; account_reference: string | null; business_id: string | null; customer_id: string | null }>(
        `SELECT id, account_reference, business_id, customer_id
           FROM requests
           WHERE type='c2b' AND status='completed' AND (business_id IS NULL OR customer_id IS NULL)
           ORDER BY created_at DESC LIMIT $1`, [limit]);
      const out: UnmatchedPayment[] = [];
      for (const r of rows) {
        if (r.business_id === null) {
          // Routing is off with one business: nothing is unmatched, every row belongs to it.
          if (businesses.length < 2) continue;
          const view = await getRequest(deps.db, r.id, egressIps);
          if (view) out.push({ ...view, reason: 'no_business', businessId: null, customerNumber: null });
          continue;
        }
        const business = businesses.find((b) => b.id === r.business_id);
        if (!business) continue;
        const number = typedCustomerNumber(String(r.account_reference ?? ''), business.code.trim(), businesses.length);
        // The payer named the business and no customer: there is nothing to decide.
        if (number === null) continue;
        const view = await getRequest(deps.db, r.id, egressIps);
        if (view) out.push({ ...view, reason: 'no_customer', businessId: business.id, customerNumber: number });
      }
      return out;
    },
  };
}
