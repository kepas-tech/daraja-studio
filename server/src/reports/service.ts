import type { Db } from '../db/pool.js';
import { countedIn } from '../money_in/link.js';
import { COLLECT_TYPES, MONEY_IN_TYPES, MONEY_TYPES } from '../money_out/registry.js';

/**
 * Feature 6, the server half: how the week went. Money in and out per Nairobi day, the success
 * rate made of two named numbers, and why the failed ones failed.
 *
 * Reads only. Nothing in this file writes a row, and no query here selects a phone number, a
 * receipt or a secret: the page and its spreadsheet carry amounts, counts and reasons.
 */

/**
 * Which rows count as money. Money in is a payment a customer made; money out is money this studio
 * sent or sent back. Balance checks and lookups are housekeeping, never money, so they appear in no
 * number here. Both lists come from the registry rather than a copy, so a new send kind joins the
 * reports the day it joins History.
 */
const IN_TYPES: string[] = [...COLLECT_TYPES, ...MONEY_IN_TYPES];
const OUT_TYPES: string[] = [...MONEY_TYPES];
const LEDGER_TYPES: string[] = [...IN_TYPES, ...OUT_TYPES];

/**
 * A send Safaricom accepted counts as money on its way, the same rule Home's per-business summary
 * uses: sent and completed both leave, unknown does not (Studio does not know yet), and failed
 * never did. Money in counts only what actually arrived. The argument is the caller's own
 * placeholder for that query's list of types, so a query that needs both directions passes two.
 */
/** Money that arrived and counts: a paid prompt whose confirmation is on record counts once, as the
 * confirmation (money_in/link.ts). */
const inMoney = (p: string) => `r.type = ANY(${p}::text[]) AND r.status = 'completed' AND ${countedIn('r')}`;
const outMoney = (p: string) => `r.type = ANY(${p}::text[]) AND r.status IN ('sent','completed')`;

/** The line the failure list shows when Safaricom sent no reason of its own. */
export const NO_REASON = 'Safaricom did not say why.';

export interface ReportDay {
  /** A Nairobi day, YYYY-MM-DD. */
  day: string;
  inCents: number; inCount: number;
  outCents: number; outCount: number;
  completed: number; failed: number; unknown: number;
}
export interface ReportFailure { reason: string; count: number; amountCents: number }
export interface ReportBusiness { businessId: string; code: string; name: string; inCents: number; outCents: number }
export interface ReportTotals {
  inCents: number; inCount: number; outCents: number; outCount: number;
  completed: number; failed: number; unknown: number;
}
export interface ReportsView {
  window: { days: number; from: string; to: string };
  days: ReportDay[];
  totals: ReportTotals;
  failures: ReportFailure[];
  /**
   * Who the money belonged to, for the chosen window. Empty when the caller picked one business
   * (one line repeating the filter says nothing), and empty with a single business: routing is off,
   * so every row belongs to it already.
   */
  byBusiness: ReportBusiness[];
}
export interface HomeSummary {
  inCents: number; inCount: number; outCents: number; outCount: number;
  /** Rows that have not finished: still preparing, at Safaricom, or waiting for approval. */
  pending: number; failed: number;
  /**
   * Round 3, phase B: what Home leads with depends on the kind of business, so two more figures ride
   * along. Money in since the first of this Nairobi month, and what open invoices still ask for.
   */
  monthInCents: number;
  unpaidInvoiceCents: number; unpaidInvoiceCount: number;
}

export interface ReportsService {
  view(opts: { days: number; businessId?: string | null }): Promise<ReportsView>;
  /** The last 24 hours, for the line on Home. */
  summary(): Promise<HomeSummary>;
}

const ZERO: ReportTotals = { inCents: 0, inCount: 0, outCents: 0, outCount: 0, completed: 0, failed: 0, unknown: 0 };

export function createReportsService(deps: { db: Db }): ReportsService {
  /** The owner's own clock: a day is a Nairobi day, whatever the server's timezone is. */
  const TODAY = "(now() AT TIME ZONE 'Africa/Nairobi')::date";

  async function window(days: number): Promise<{ from: string; to: string }> {
    const [b] = await deps.db.query<{ from_day: string; to_day: string }>(
      `SELECT (${TODAY} - ($1::int - 1))::text AS from_day, ${TODAY}::text AS to_day`, [days]);
    return { from: b.from_day, to: b.to_day };
  }

  /**
   * One line per day in the window, zeros included: a gap in the table is a real answer, and the
   * spreadsheet has the same shape as the screen. The day list is generated, never built from the
   * rows, so a day with nothing is still a line.
   */
  async function days(from: string, to: string, businessId: string | null): Promise<ReportDay[]> {
    const rows = await deps.db.query<{
      day: string; in_count: number; in_cents: string; out_count: number; out_cents: string;
      completed: number; failed: number; unknown: number;
    }>(
      `WITH bounds AS (SELECT $1::date AS from_day, $2::date AS to_day),
       series AS (SELECT generate_series(from_day::timestamp, to_day::timestamp, interval '1 day')::date AS day FROM bounds),
       agg AS (
         SELECT (r.created_at AT TIME ZONE 'Africa/Nairobi')::date AS day,
                COUNT(*) FILTER (WHERE ${inMoney('$5')})::int AS in_count,
                COALESCE(SUM(r.amount_cents) FILTER (WHERE ${inMoney('$5')}), 0)::bigint AS in_cents,
                COUNT(*) FILTER (WHERE ${outMoney('$6')})::int AS out_count,
                COALESCE(SUM(r.amount_cents) FILTER (WHERE ${outMoney('$6')}), 0)::bigint AS out_cents,
                COUNT(*) FILTER (WHERE r.status = 'completed')::int AS completed,
                COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE r.status = 'unknown')::int AS unknown
           FROM requests r, bounds b
          WHERE (r.created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN b.from_day AND b.to_day
            AND r.type = ANY($3::text[])
            AND ($4::uuid IS NULL OR r.business_id = $4::uuid)
          GROUP BY 1)
       SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
              COALESCE(a.in_count, 0) AS in_count, COALESCE(a.in_cents, 0) AS in_cents,
              COALESCE(a.out_count, 0) AS out_count, COALESCE(a.out_cents, 0) AS out_cents,
              COALESCE(a.completed, 0) AS completed, COALESCE(a.failed, 0) AS failed, COALESCE(a.unknown, 0) AS unknown
         FROM series s LEFT JOIN agg a ON a.day = s.day
        ORDER BY s.day`, [from, to, LEDGER_TYPES, businessId, IN_TYPES, OUT_TYPES]);
    return rows.map((r) => ({
      day: r.day, inCents: Number(r.in_cents), inCount: r.in_count,
      outCents: Number(r.out_cents), outCount: r.out_count,
      completed: r.completed, failed: r.failed, unknown: r.unknown,
    }));
  }

  /**
   * Why things failed, the last 7 Nairobi days. Grouped by Safaricom's own reason line; a failed
   * row Safaricom gave no reason for is one group of its own rather than a hole in the list. The
   * business filter applies here too: a page filtered to one business must never show another
   * business's failures under its name.
   */
  async function failures(businessId: string | null): Promise<ReportFailure[]> {
    const rows = await deps.db.query<{ reason: string; n: number; cents: string }>(
      `SELECT COALESCE(NULLIF(btrim(r.result_desc), ''), $2) AS reason,
              COUNT(*)::int AS n,
              COALESCE(SUM(r.amount_cents), 0)::bigint AS cents
         FROM requests r
        WHERE r.status = 'failed'
          AND r.type = ANY($1::text[])
          AND (r.created_at AT TIME ZONE 'Africa/Nairobi')::date > ${TODAY} - 7
          AND ($3::uuid IS NULL OR r.business_id = $3::uuid)
        GROUP BY 1
        ORDER BY n DESC, cents DESC, reason ASC`, [LEDGER_TYPES, NO_REASON, businessId]);
    return rows.map((r) => ({ reason: r.reason, count: r.n, amountCents: Number(r.cents) }));
  }

  /** In and out per business for the window, by code: the same picture Home shows. */
  async function byBusiness(from: string, to: string): Promise<ReportBusiness[]> {
    const [{ n }] = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM businesses');
    if (n < 2) return [];
    const rows = await deps.db.query<{ business_id: string; code: string; name: string; in_cents: string; out_cents: string }>(
      `SELECT b.id AS business_id, b.code, b.name,
              COALESCE(SUM(r.amount_cents) FILTER (WHERE ${inMoney('$4')}), 0)::bigint AS in_cents,
              COALESCE(SUM(r.amount_cents) FILTER (WHERE ${outMoney('$5')}), 0)::bigint AS out_cents
         FROM businesses b
         LEFT JOIN requests r ON r.business_id = b.id
              AND (r.created_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN $1::date AND $2::date
              AND r.type = ANY($3::text[])
        GROUP BY b.id, b.code, b.name
        ORDER BY b.code`, [from, to, LEDGER_TYPES, IN_TYPES, OUT_TYPES]);
    return rows.map((r) => ({ businessId: r.business_id, code: r.code.trim(), name: r.name, inCents: Number(r.in_cents), outCents: Number(r.out_cents) }));
  }

  return {
    async view({ days: count, businessId = null }) {
      const { from, to } = await window(count);
      const [list, failed, split] = await Promise.all([
        days(from, to, businessId),
        failures(businessId),
        businessId === null ? byBusiness(from, to) : Promise.resolve([]),
      ]);
      // The totals are the table added up, so the two can never disagree on the page.
      const totals = list.reduce<ReportTotals>((t, d) => ({
        inCents: t.inCents + d.inCents, inCount: t.inCount + d.inCount,
        outCents: t.outCents + d.outCents, outCount: t.outCount + d.outCount,
        completed: t.completed + d.completed, failed: t.failed + d.failed, unknown: t.unknown + d.unknown,
      }), { ...ZERO });
      return { window: { days: count, from, to }, days: list, totals, failures: failed, byBusiness: split };
    },

    async summary() {
      const [row] = await deps.db.query<{
        in_cents: string; in_count: number; out_cents: string; out_count: number; pending: number; failed: number;
      }>(
        `SELECT COALESCE(SUM(r.amount_cents) FILTER (WHERE ${inMoney('$2')}), 0)::bigint AS in_cents,
                COUNT(*) FILTER (WHERE ${inMoney('$2')})::int AS in_count,
                COALESCE(SUM(r.amount_cents) FILTER (WHERE ${outMoney('$3')}), 0)::bigint AS out_cents,
                COUNT(*) FILTER (WHERE ${outMoney('$3')})::int AS out_count,
                COUNT(*) FILTER (WHERE r.status IN ('pending','sent','awaiting_approval'))::int AS pending,
                COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed
           FROM requests r
          WHERE r.type = ANY($1::text[]) AND r.created_at > now() - interval '24 hours'`, [LEDGER_TYPES, IN_TYPES, OUT_TYPES]);
      const [month] = await deps.db.query<{ cents: string }>(
        `SELECT COALESCE(SUM(r.amount_cents), 0)::bigint AS cents FROM requests r
          WHERE ${inMoney('$1')}
            AND r.created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Nairobi') AT TIME ZONE 'Africa/Nairobi'`,
        [IN_TYPES]);
      // Open invoices: what was asked for, less what has been paid. A cancelled or paid invoice is
      // not owed. Money Studio never held, and never will: this is a total of what people owe.
      const [owed] = await deps.db.query<{ cents: string; n: number }>(
        `SELECT COALESCE(SUM(amount_cents - paid_cents), 0)::bigint AS cents, COUNT(*)::int AS n
           FROM customer_invoices WHERE status IN ('sent','partly_paid')`);
      if (!row) {
        return { inCents: 0, inCount: 0, outCents: 0, outCount: 0, pending: 0, failed: 0, monthInCents: Number(month?.cents ?? 0), unpaidInvoiceCents: Number(owed?.cents ?? 0), unpaidInvoiceCount: owed?.n ?? 0 };
      }
      return {
        inCents: Number(row.in_cents), inCount: row.in_count,
        outCents: Number(row.out_cents), outCount: row.out_count,
        pending: row.pending, failed: row.failed,
        monthInCents: Number(month?.cents ?? 0),
        unpaidInvoiceCents: Number(owed?.cents ?? 0), unpaidInvoiceCount: owed?.n ?? 0,
      };
    },
  };
}

