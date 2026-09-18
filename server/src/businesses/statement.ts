import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import type { InvoiceInput } from '../invoices/service.js';
import { INCOMING_TYPES, MONEY_TYPES } from '../money_out/registry.js';
import { OTHER_TEMPLATE, typeFor, type BusinessTypeView } from './types.js';

/**
 * Round 3, phase C: one account's running statement, and who is behind.
 *
 * Everything here is read from rows that exist — payments in, payouts out, invoices raised — never
 * from money Studio holds, because Studio holds none. The only number the template supplies is what
 * each period expects: the kind of business says whether money is expected regularly and how often,
 * and the account itself says how much.
 *
 * The arrears rule, in one line: **owed = what is due by now, less what has arrived, and never less
 * than the invoices already raised and unpaid.** A period is due only once it has finished, so
 * nothing is ever demanded for a period that has not run yet; for a kind whose periods have no
 * length of their own (each term, at a school) the invoices carry the demand on their own.
 */

export interface Actor { personId: string; ip: string }

export interface StatementRow {
  at: string;
  /** Money in, money out, or an invoice raised. */
  kind: 'in' | 'out' | 'invoice';
  /** What it was, in the studio's own words: the payment type, the send's category, or the period billed. */
  label: string;
  amountCents: number;
  status: string;
  receipt: string | null;
  /** The invoice's own reference, on an invoice row. */
  reference: string | null;
  /** Set when this row belongs to an account under the one being read. */
  accountName: string | null;
  requestId: string | null;
  invoiceId: string | null;
}

export interface StatementSchedule {
  regular: BusinessTypeView['template']['regular'];
  standingAmount: BusinessTypeView['template']['standingAmount'];
  /** Whole periods that have finished since the account started. Zero when the kind sets no period. */
  periodsDue: number;
  /** standingCents × periodsDue; null when there is no schedule or no amount set. */
  expectedCents: number | null;
}

export interface StatementView {
  account: {
    id: string; name: string; fullNumber: string; phone: string | null; note: string | null;
    businessId: string; businessName: string; businessCode: string; parentId: string | null;
  };
  type: BusinessTypeView;
  standingCents: number | null;
  schedule: StatementSchedule;
  paidInCents: number;
  paidOutCents: number;
  invoicedCents: number;
  unpaidInvoiceCents: number;
  unpaidInvoiceCount: number;
  /** What is still owed today, by the rule above. */
  owedCents: number;
  /** How many of the kind's periods that amount covers. */
  behindPeriods: number;
  lastRemindedAt: string | null;
  rows: StatementRow[];
}

export interface ArrearsRow {
  accountId: string; name: string; fullNumber: string;
  standingCents: number | null;
  periodsDue: number;
  expectedCents: number | null;
  paidInCents: number;
  owedCents: number;
  behindPeriods: number;
  lastRemindedAt: string | null;
  /** The oldest invoice still unpaid, which is the first thing to chase. */
  oldestInvoice: { id: string; reference: string; billedPeriod: string; dueDate: string; amountCents: number; paidCents: number } | null;
}

export interface ArrearsView {
  businessId: string; businessName: string; businessCode: string;
  type: BusinessTypeView;
  /** False when the kind expects nothing regular, or expects a pledge rather than a set amount. */
  hasArrears: boolean;
  rows: ArrearsRow[];
  behindCount: number;
  owedCents: number;
}

export interface StatementService {
  statement(accountId: string): Promise<StatementView>;
  arrears(businessId: string): Promise<ArrearsView>;
  /** The next invoice for one account, ready for the invoices service. Nothing is sent here. */
  nextInvoice(accountId: string): Promise<InvoiceInput>;
  /** The reminder Studio drafts, and the record that it was prepared. The owner sends it. */
  remind(accountId: string, actor: Actor): Promise<{ message: string; phone: string | null; owedCents: number }>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The Nairobi day, month and year of a moment. */
function nairobi(d: Date): { day: string; month: string; year: string; monthIndex: number } {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  return { day: String(t.getUTCDate()).padStart(2, '0'), month: MONTHS[t.getUTCMonth()]!, year: String(t.getUTCFullYear()), monthIndex: t.getUTCMonth() };
}

/** The day the next period's money is asked for: a month out, a week out, or a term out. */
function dueDateFor(regular: BusinessTypeView['template']['regular'], now = new Date()): string {
  const days = regular === 'weekly' ? 7 : regular === 'each_term' ? 90 : 30;
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** What one period is called, on the invoice and in the statement. */
export function periodLabel(regular: BusinessTypeView['template']['regular'], now = new Date()): string {
  const n = nairobi(now);
  if (regular === 'weekly') return `Week of ${n.day} ${n.month} ${n.year}`;
  // Three school terms a year: January to April, May to August, September to December. It is a
  // label on an invoice the owner can change, not a calendar Studio enforces anywhere else.
  if (regular === 'each_term') return `Term ${Math.floor(n.monthIndex / 4) + 1} ${n.year}`;
  return `${n.month} ${n.year}`;
}

function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

/**
 * Whole periods that have finished between an account starting and now. A calendar month for a
 * monthly kind, seven days for a weekly one, and nothing for a kind with no period of its own.
 * Counted in SQL so the database's own calendar does the arithmetic, in Nairobi time.
 */
const PERIODS_DUE: Record<string, string> = {
  monthly: `(date_part('year', age(now() AT TIME ZONE 'Africa/Nairobi', a.created_at AT TIME ZONE 'Africa/Nairobi')) * 12
             + date_part('month', age(now() AT TIME ZONE 'Africa/Nairobi', a.created_at AT TIME ZONE 'Africa/Nairobi')))::int`,
  weekly: `floor(EXTRACT(EPOCH FROM (now() - a.created_at)) / 604800)::int`,
  each_term: `0`,
  no: `0`,
};

interface AccountRow {
  id: string; business_id: string; parent_id: string | null; number: string; full_number: string; name: string; phone: string | null;
  note: string | null; standing_cents: number | null; last_reminded_at: Date | null; created_at: Date;
  business_name: string; business_code: string; type_key: string | null;
}

export function createStatementService(deps: { db: Db }): StatementService {
  const account = async (id: string): Promise<AccountRow> => {
    const [row] = await deps.db.query<AccountRow>(
      `SELECT a.*, b.name AS business_name, b.code AS business_code, b.type_key
         FROM accounts a JOIN businesses b ON b.id = a.business_id
        WHERE a.id = $1 AND a.org_id = $2`, [id, requireOrg()]);
    if (!row) throw new HttpError(404, 'not_found', 'That account does not exist.');
    return row;
  };

  /** An account and any accounts under it: one statement covers the customer and their rooms. */
  const family = async (row: AccountRow): Promise<AccountRow[]> => {
    if (row.parent_id) return [row];
    const children = await deps.db.query<AccountRow>(
      `SELECT a.*, b.name AS business_name, b.code AS business_code, b.type_key
         FROM accounts a JOIN businesses b ON b.id = a.business_id
        WHERE a.parent_id = $1 ORDER BY a.number`, [row.id]);
    return [row, ...children];
  };

  /** The figures behind one statement: what arrived, what went out, what was invoiced, what is owed. */
  async function figures(rows: AccountRow[], type: BusinessTypeView) {
    const ids = rows.map((r) => r.id);
    const numbers = rows.map((r) => r.full_number);
    const [money] = await deps.db.query<{ in_cents: string; out_cents: string }>(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type = ANY($2::text[]) AND status = 'completed'), 0)::bigint AS in_cents,
              COALESCE(SUM(amount_cents) FILTER (WHERE type = ANY($3::text[]) AND status IN ('sent','completed')), 0)::bigint AS out_cents
         FROM requests WHERE account_id = ANY($1::uuid[])`, [ids, INCOMING_TYPES, MONEY_TYPES]);
    const [inv] = await deps.db.query<{ invoiced: string; unpaid: string; n: number }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS invoiced,
              COALESCE(SUM(amount_cents - paid_cents) FILTER (WHERE status IN ('sent','partly_paid')), 0)::bigint AS unpaid,
              COUNT(*) FILTER (WHERE status IN ('sent','partly_paid'))::int AS n
         FROM customer_invoices WHERE account_reference = ANY($1::text[])`, [numbers]);

    const paidInCents = Number(money?.in_cents ?? 0);
    const paidOutCents = Number(money?.out_cents ?? 0);
    const unpaidInvoiceCents = Number(inv?.unpaid ?? 0);

    // What the kind expects by now, when it expects anything regular at all and this account has a
    // standing amount. Pledges have no set amount, so they carry no schedule.
    const hasSchedule = type.template.regular !== 'no' && type.template.standingAmount === 'fixed';
    const stands = rows[0]?.standing_cents ?? null;
    const [periods] = rows.length > 0
      ? await deps.db.query<{ due: number }>(`SELECT ${PERIODS_DUE[type.template.regular]} AS due FROM accounts a WHERE a.id = $1`, [rows[0]!.id])
      : [{ due: 0 }];
    const periodsDue = Number(periods?.due ?? 0);
    const expectedCents = hasSchedule && stands !== null ? periodsDue * stands : null;

    // The rule: what is due by now, less what arrived, and never less than the invoices raised.
    const scheduleShortfall = expectedCents === null ? 0 : Math.max(0, expectedCents - paidInCents);
    const owedCents = Math.max(scheduleShortfall, unpaidInvoiceCents);
    const behindPeriods = stands !== null && stands > 0 ? Math.ceil(owedCents / stands) : 0;
    return {
      paidInCents, paidOutCents, unpaidInvoiceCents, unpaidInvoiceCount: inv?.n ?? 0,
      invoicedCents: Number(inv?.invoiced ?? 0), expectedCents, periodsDue, owedCents, behindPeriods,
      hasSchedule, standingCents: stands,
    };
  }

  /** Every row that has ever touched this account, oldest first, as the three things there are. */
  async function rowsFor(accounts: AccountRow[]): Promise<StatementRow[]> {
    const ids = accounts.map((r) => r.id);
    const numbers = accounts.map((r) => r.full_number);
    const nameOf = new Map(accounts.map((r) => [r.id, r.name]));
    const money = await deps.db.query<{ id: string; type: string; subtype: string | null; status: string; amount_cents: string; receipt: string | null; created_at: Date; account_id: string }>(
      `SELECT id, type, subtype, status, amount_cents, receipt, created_at, account_id FROM requests
        WHERE account_id = ANY($1::uuid[]) ORDER BY created_at`, [ids]);
    const invoices = await deps.db.query<{ id: string; external_reference: string; billed_period: string; amount_cents: string; paid_cents: string; status: string; sent_at: Date; account_reference: string }>(
      `SELECT id, external_reference, billed_period, amount_cents, paid_cents, status, sent_at, account_reference FROM customer_invoices
        WHERE account_reference = ANY($1::text[]) ORDER BY sent_at`, [numbers]);

    const out: StatementRow[] = money.map((r) => ({
      at: r.created_at.toISOString(),
      kind: INCOMING_TYPES.includes(r.type) ? 'in' as const : 'out' as const,
      label: r.subtype ?? r.type,
      amountCents: Number(r.amount_cents),
      status: r.status,
      receipt: r.receipt,
      reference: null,
      accountName: nameOf.get(r.account_id) ?? null,
      requestId: r.id,
      invoiceId: null,
    }));
    for (const i of invoices) {
      out.push({
        at: i.sent_at.toISOString(),
        kind: 'invoice',
        label: i.billed_period,
        amountCents: Number(i.amount_cents),
        status: i.status,
        receipt: null,
        reference: i.external_reference,
        accountName: accounts.find((a) => a.full_number === i.account_reference)?.name ?? null,
        requestId: null,
        invoiceId: i.id,
      });
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  /** One account's statement, from the rows that exist and the kind's own template. */
  async function buildStatement(accountId: string): Promise<StatementView> {
      const row = await account(accountId);
      const type = (await typeFor(deps.db, row.type_key)) ?? { key: 'other', name: 'Other', template: OTHER_TEMPLATE };
      const familyRows = await family(row);
      const [fig, rows] = await Promise.all([figures(familyRows, type), rowsFor(familyRows)]);
      return {
        account: {
          id: row.id, name: row.name, fullNumber: row.full_number, phone: row.phone, note: row.note,
          businessId: row.business_id, businessName: row.business_name, businessCode: row.business_code.trim(), parentId: row.parent_id,
        },
        type,
        standingCents: fig.standingCents,
        schedule: { regular: type.template.regular, standingAmount: type.template.standingAmount, periodsDue: fig.periodsDue, expectedCents: fig.expectedCents },
        paidInCents: fig.paidInCents, paidOutCents: fig.paidOutCents,
        invoicedCents: fig.invoicedCents, unpaidInvoiceCents: fig.unpaidInvoiceCents, unpaidInvoiceCount: fig.unpaidInvoiceCount,
        owedCents: fig.owedCents, behindPeriods: fig.behindPeriods,
        lastRemindedAt: row.last_reminded_at?.toISOString() ?? null,
        rows,
      };
  }

  return {
    statement: buildStatement,

    // Who is behind, for a kind that expects money regularly and has a set amount per account. A
    // kind that expects nothing regular gets no list at all — there is nothing to be behind on.
    async arrears(businessId) {
      const [business] = await deps.db.query<{ id: string; name: string; code: string; type_key: string | null }>(
        'SELECT id, name, code, type_key FROM businesses WHERE id = $1 AND org_id = $2', [businessId, requireOrg()]);
      if (!business) throw new HttpError(404, 'not_found', 'That business does not exist.');
      const type = (await typeFor(deps.db, business.type_key))!;
      const hasArrears = type.template.regular !== 'no' && type.template.standingAmount === 'fixed';
      const rows = await deps.db.query<AccountRow>(
        `SELECT a.*, b.name AS business_name, b.code AS business_code, b.type_key
           FROM accounts a JOIN businesses b ON b.id = a.business_id
          WHERE a.business_id = $1 AND a.parent_id IS NULL ORDER BY a.number`, [businessId]);
      const out: ArrearsRow[] = [];
      for (const r of rows) {
        const familyRows = await family(r);
        const [fig] = [await figures(familyRows, type)];
        const [invoice] = await deps.db.query<{ id: string; external_reference: string; billed_period: string; due_date: string; amount_cents: string; paid_cents: string }>(
          `SELECT id, external_reference, billed_period, to_char(due_date, 'YYYY-MM-DD') AS due_date, amount_cents, paid_cents
             FROM customer_invoices WHERE account_reference = ANY($1::text[]) AND status IN ('sent','partly_paid')
            ORDER BY due_date ASC, sent_at ASC LIMIT 1`,
          [familyRows.map((f) => f.full_number)]);
        out.push({
          accountId: r.id, name: r.name, fullNumber: r.full_number,
          standingCents: fig.standingCents, periodsDue: fig.periodsDue, expectedCents: fig.expectedCents,
          paidInCents: fig.paidInCents, owedCents: fig.owedCents, behindPeriods: fig.behindPeriods,
          lastRemindedAt: r.last_reminded_at?.toISOString() ?? null,
          oldestInvoice: invoice ? {
            id: invoice.id, reference: invoice.external_reference, billedPeriod: invoice.billed_period,
            dueDate: invoice.due_date, amountCents: Number(invoice.amount_cents), paidCents: Number(invoice.paid_cents),
          } : null,
        });
      }
      // Most behind first, then the largest amount, then the number: the order a person chases them.
      out.sort((a, b) => b.owedCents - a.owedCents || a.periodsDue - b.periodsDue || a.fullNumber.localeCompare(b.fullNumber));
      return {
        businessId: business.id, businessName: business.name, businessCode: business.code.trim(), type, hasArrears,
        rows: out, behindCount: out.filter((r) => r.owedCents > 0).length, owedCents: out.reduce((s, r) => s + r.owedCents, 0),
      };
    },

    // The next invoice, built and nothing else: the invoices service sends it, and only because a
    // person pressed the button.
    async nextInvoice(accountId) {
      const row = await account(accountId);
      const type = (await typeFor(deps.db, row.type_key))!;
      if (row.standing_cents === null) {
        throw new HttpError(409, 'no_standing_amount', 'This account has no standing amount yet. Set what is expected each period first.');
      }
      return {
        customerName: row.name,
        customerPhone: row.phone ?? '',
        invoiceName: type.template.statementNoun,
        accountReference: row.full_number,
        billedPeriod: periodLabel(type.template.regular),
        dueDate: dueDateFor(type.template.regular),
        amountCents: row.standing_cents,
        accountId: row.id,
      };
    },

    // A reminder is a message Studio writes and the owner sends: Safaricom has no reminder call, and
    // Studio has no line of its own to a payer's phone. Preparing one records that it was done.
    async remind(accountId, actor) {
      const row = await account(accountId);
      const view = await buildStatement(accountId);
      const oldest = view.rows.find((r) => r.kind === 'invoice' && r.status !== 'paid' && r.status !== 'cancelled');
      const owed = view.owedCents;
      const message = [
        `Hello ${row.name},`,
        oldest ? `${oldest.label} is still outstanding${owed > 0 ? `: KES ${(owed / 100).toLocaleString('en-KE')}` : ''}.` : `KES ${(owed / 100).toLocaleString('en-KE')} is still outstanding.`,
        `Pay to ${view.account.businessName}, account ${row.full_number}.`,
      ].join(' ');
      await deps.db.query('UPDATE accounts SET last_reminded_at = now() WHERE id = $1', [accountId]);
      await audit(deps.db, {
        personId: actor.personId, action: 'account.reminded', target: accountId,
        after: { owedCents: owed, fullNumber: row.full_number }, ip: actor.ip,
      });
      return { message, phone: row.phone, owedCents: owed };
    },
  };
}
