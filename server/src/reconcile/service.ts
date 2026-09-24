import type { Db } from '../db/pool.js';
import { countedIn } from '../money_in/link.js';
import { HttpError } from '../util/errors.js';
import type { Settings, Env } from '../settings/store.js';
import type { DarajaFactory } from '../sdk/client.js';
import { eatStamp } from '../money_in/service.js';
import { COLLECT_TYPES, MONEY_IN_TYPES, MONEY_TYPES } from '../money_out/registry.js';

/**
 * Round 3, phase D-1: check nothing is missing.
 *
 * Three reads, no writes. Safaricom's own record is pulled for a window and compared with the rows
 * Studio has; anything Safaricom shows that Studio does not have is listed, and anything Studio has
 * that the pull did not return is listed beside it. Then the two latest balances Safaricom reported
 * are compared with the money that moved between them, so a business can see whether its books are
 * complete — the only truth is the statement Safaricom keeps, because Studio holds no money.
 *
 * Nothing here is stored, corrected or applied. Listing a missing payment is not recording it: the
 * owner decides what to do, and the press that records is Check for missed payments on Money in.
 */

const PULL_PAGE = 100;
const MAX_PAGES = 20;

export interface MissingRow {
  receipt: string;
  amountCents: number;
  at: string | null;
  phone: string | null;
  accountReference: string | null;
}
export interface ExtraRow {
  id: string;
  type: string;
  receipt: string | null;
  amountCents: number;
  at: string;
  accountReference: string | null;
}

export interface ReconcileView {
  window: { days: number; from: string; to: string };
  safaricom: { records: number; totalCents: number };
  studio: { records: number; totalCents: number };
  /** What Safaricom shows and Studio has no row for. */
  missing: MissingRow[];
  /** What Studio has in the window and the pull did not return. */
  extra: ExtraRow[];
  balance: {
    latest: { workingCents: number | null; utilityCents: number | null; at: string } | null;
    previous: { workingCents: number | null; utilityCents: number | null; at: string } | null;
    /**
     * What moved between the two readings, and what the two accounts together should have done.
     * Studio does not assume which float account Safaricom credits, so the comparison is on the two
     * of them added up; each account's own change is shown beside it.
     */
    movement: {
      inCents: number; outCents: number; chargeCents: number; paymentsIn: number; paymentsOut: number;
      workingChangeCents: number | null; utilityChangeCents: number | null;
      expectedChangeCents: number | null; actualChangeCents: number | null; differenceCents: number | null;
    };
  };
  checkedAt: string;
}

export interface ReconcileService {
  check(days: number): Promise<ReconcileView>;
}

/** The receipt and the amount of one pulled record, via the same field names the pull uses. */
function pulledRecord(t: Record<string, unknown>): MissingRow | null {
  const s = (k: string) => { const v = t[k]; return v == null ? '' : String(v); };
  const receipt = s('transactionId') || s('TransID');
  if (!receipt) return null;
  const amount = Number(s('amount') || s('TransAmount'));
  const date = (s('trxDate') || s('TransTime')).replace(/[^0-9]/g, '').slice(0, 14);
  const at = /^[0-9]{14}$/.test(date)
    ? new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(8, 10) - 3, +date.slice(10, 12), +date.slice(12, 14))).toISOString()
    : null;
  return {
    receipt,
    amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
    at,
    phone: (s('msisdn') || s('MSISDN')) || null,
    accountReference: (s('billreference') || s('BillRefNumber')) || null,
  };
}

export function createReconcileService(deps: { db: Db; settings: Settings; daraja: DarajaFactory }): ReconcileService {
  const IN_TYPES = [...COLLECT_TYPES, ...MONEY_IN_TYPES];
  const STUDIO_ROWS = `SELECT id, type, receipt, amount_cents, created_at, account_reference FROM requests WHERE type = ANY($1::text[]) AND status = $2 AND created_at >= $3 AND ${countedIn('')} ORDER BY created_at`;
  const MOVED = `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type = ANY($3::text[]) AND status = $5 AND ${countedIn('')}), 0)::bigint AS in_cents, COALESCE(SUM(amount_cents) FILTER (WHERE type = ANY($4::text[]) AND status = ANY($6::text[])), 0)::bigint AS out_cents, COALESCE(SUM(charge_cents), 0)::bigint AS charge_cents, COUNT(*) FILTER (WHERE type = ANY($3::text[]) AND status = $5 AND ${countedIn('')})::int AS in_n, COUNT(*) FILTER (WHERE type = ANY($4::text[]) AND status = ANY($6::text[]))::int AS out_n FROM requests WHERE created_at > $1 AND created_at <= $2`;

  return {
    async check(days) {
      const env = ((await deps.settings.get('daraja.environment')) as Env) ?? 'sandbox';
      if (!(await deps.settings.get(`env.${env}.pullRegisteredAt`))) {
        throw new HttpError(409, 'not_registered', 'Turn on Money in first, so Safaricom can be asked for its record.');
      }
      const end = new Date();
      const start = new Date(end.getTime() - days * 24 * 3_600_000);

      // 1. Safaricom's own record for the window. Read only: nothing found here is written.
      const client = await deps.daraja.get();
      const pulled: MissingRow[] = [];
      const seen = new Set<string>();
      for (let offset = 0, page = 0; page < MAX_PAGES; offset += PULL_PAGE, page++) {
        const answer = await client.pull.query({ startDate: eatStamp(start), endDate: eatStamp(end), offset });
        for (const t of answer.transactions) {
          const r = pulledRecord(t);
          if (r && !seen.has(r.receipt)) { seen.add(r.receipt); pulled.push(r); }
        }
        if (answer.transactions.length < PULL_PAGE) break;
      }

      // 2. What Studio recorded in the same window: paybill payments and the kinds that land without
      // a request of ours. Only money in is comparable with the pull.
      const studio = await deps.db.query<{ id: string; type: string; receipt: string | null; amount_cents: string; created_at: Date; account_reference: string | null }>(
        STUDIO_ROWS, [IN_TYPES, 'completed', start]);
      const byReceipt = new Map(studio.filter((r) => r.receipt).map((r) => [r.receipt as string, r]));
      const missing = pulled.filter((p) => !byReceipt.has(p.receipt));
      const extra = studio
        .filter((r) => !r.receipt || !seen.has(r.receipt))
        .map((r) => ({ id: r.id, type: r.type, receipt: r.receipt, amountCents: Number(r.amount_cents), at: r.created_at.toISOString(), accountReference: r.account_reference }));

      // 3. The two latest balances Safaricom reported, against the money that moved between them.
      const readings = await deps.db.query<{ working_cents: string | null; utility_cents: string | null; queried_at: Date }>(
        'SELECT working_cents, utility_cents, queried_at FROM balances ORDER BY queried_at DESC LIMIT 2');
      const latest = readings[0] ?? null;
      const previous = readings[1] ?? null;
      let movement = {
        inCents: 0, outCents: 0, chargeCents: 0, paymentsIn: 0, paymentsOut: 0,
        workingChangeCents: null as number | null, utilityChangeCents: null as number | null,
        expectedChangeCents: null as number | null, actualChangeCents: null as number | null, differenceCents: null as number | null,
      };
      if (latest && previous) {
        const [moved] = await deps.db.query<{ in_cents: string; out_cents: string; charge_cents: string; in_n: number; out_n: number }>(
          MOVED, [previous.queried_at, latest.queried_at, IN_TYPES, MONEY_TYPES, 'completed', ['sent', 'completed']]);
        const inCents = Number(moved?.in_cents ?? 0);
        const outCents = Number(moved?.out_cents ?? 0);
        const chargeCents = Number(moved?.charge_cents ?? 0);
        const w0 = previous.working_cents === null ? null : Number(previous.working_cents);
        const u0 = previous.utility_cents === null ? null : Number(previous.utility_cents);
        const w1 = latest.working_cents === null ? null : Number(latest.working_cents);
        const u1 = latest.utility_cents === null ? null : Number(latest.utility_cents);
        const totalBefore = w0 === null || u0 === null ? null : w0 + u0;
        const totalAfter = w1 === null || u1 === null ? null : w1 + u1;
        // Money in adds; payouts and Safaricom's charges take away. Which float account either one
        // lands in is Safaricom's business, so the check compares the two of them together.
        const expectedChange = inCents - outCents - chargeCents;
        const actualChange = totalBefore === null || totalAfter === null ? null : totalAfter - totalBefore;
        movement = {
          inCents, outCents, chargeCents, paymentsIn: moved?.in_n ?? 0, paymentsOut: moved?.out_n ?? 0,
          workingChangeCents: w0 === null || w1 === null ? null : w1 - w0,
          utilityChangeCents: u0 === null || u1 === null ? null : u1 - u0,
          expectedChangeCents: expectedChange, actualChangeCents: actualChange,
          differenceCents: actualChange === null ? null : actualChange - expectedChange,
        };
      }

      return {
        window: { days, from: start.toISOString(), to: end.toISOString() },
        safaricom: { records: pulled.length, totalCents: pulled.reduce((s, r) => s + r.amountCents, 0) },
        studio: { records: studio.length, totalCents: studio.reduce((s, r) => s + Number(r.amount_cents), 0) },
        missing,
        extra,
        balance: {
          latest: latest ? { workingCents: latest.working_cents === null ? null : Number(latest.working_cents), utilityCents: latest.utility_cents === null ? null : Number(latest.utility_cents), at: latest.queried_at.toISOString() } : null,
          previous: previous ? { workingCents: previous.working_cents === null ? null : Number(previous.working_cents), utilityCents: previous.utility_cents === null ? null : Number(previous.utility_cents), at: previous.queried_at.toISOString() } : null,
          movement,
        },
        checkedAt: new Date().toISOString(),
      };
    },
  };
}
