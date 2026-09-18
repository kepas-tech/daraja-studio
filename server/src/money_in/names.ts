import type { Db } from '../db/pool.js';
import type { MoneyOutService } from '../money_out/service.js';
import { HttpError } from '../util/errors.js';
import { personName } from '../util/names.js';
import { INCOMING_TYPES } from '../money_out/registry.js';

/**
 * Round 4: recovering the payer names.
 *
 * This paybill's C2B confirmation address belongs to another system, so Studio never receives the
 * confirmation that carries the payer's name — it learns of those payments from the pull, whose
 * sender is the literal word MPESA. The name is not lost though: a transaction status query by
 * receipt returns DebitPartyName with the real person on it, and the status handler already writes
 * that name onto the row Studio holds, touching nothing but the name.
 *
 * So this service only has to do two things: find the completed money-in rows that still have no
 * real name, and ask Safaricom about a few of them at a time. It never writes a name itself, never
 * changes a status, an amount or a receipt, and never asks twice in a row about the same receipt —
 * the answer arrives minutes later on the status callback, not in this call.
 */
export interface NameCandidate { id: string; receipt: string; type: string }
export interface NameBackfillResult {
  asked: number;
  /** Already in flight, or refused for a reason that is not about this receipt. */
  skipped: number;
  remaining: number;
  /** Set when the run stopped early: the shared Daraja token, Safaricom, or Studio not being ready. */
  stopped: 'auth' | 'safaricom' | 'not_ready' | null;
}
export interface NameBackfill {
  missing(limit?: number): Promise<NameCandidate[]>;
  ask(opts?: { limit?: number; gapMs?: number }): Promise<NameBackfillResult>;
}

/** A receipt asked about inside this window is left alone: the answer may still be coming. */
const ASKED_WITHIN = '6 hours';
export const NAMES_PER_RUN = 5;
export const NAME_GAP_MS = 1_500;

export function createNameBackfill(deps: { db: Db; moneyOut: Pick<MoneyOutService, 'lookup'> }): NameBackfill {
  /**
   * The rows that need a name. The SQL is a cheap prefilter — null, no letter in it, or the pull's
   * placeholder — and `personName` decides: the read layer's own helper, so a row this returns is
   * exactly a row whose name would show as nothing on screen.
   */
  async function missing(limit = 100): Promise<NameCandidate[]> {
    const rows = await deps.db.query<{ id: string; receipt: string; type: string; recipient_name: string | null }>(
      `SELECT r.id, r.receipt, r.type, r.recipient_name
         FROM requests r
        WHERE r.type = ANY($1::text[]) AND r.status = 'completed'
          AND r.receipt IS NOT NULL AND btrim(r.receipt) <> ''
          AND (r.recipient_name IS NULL OR r.recipient_name !~ '[A-Za-z]' OR upper(btrim(r.recipient_name)) LIKE '%MPESA%')
          -- Never the same receipt twice inside the window: a query's answer comes back on its own
          -- callback, so asking again before then spends a call to learn nothing.
          AND NOT EXISTS (SELECT 1 FROM requests q WHERE q.type = 'status_query' AND q.subtype = 'lookup'
                            AND q.recipient_value = r.receipt AND q.created_at > now() - interval '${ASKED_WITHIN}')
        ORDER BY COALESCE(r.result_at, r.created_at) DESC
        LIMIT $2`,
      [INCOMING_TYPES, limit],
    );
    return rows.filter((r) => personName(r.recipient_name) === null).map((r) => ({ id: r.id, receipt: r.receipt, type: r.type }));
  }

  return {
    missing,

    async ask(opts = {}) {
      const limit = opts.limit ?? NAMES_PER_RUN;
      const gapMs = opts.gapMs ?? NAME_GAP_MS;
      const candidates = await missing(limit);
      let asked = 0;
      let skipped = 0;
      let stopped: NameBackfillResult['stopped'] = null;

      for (const c of candidates) {
        try {
          // A system call: nobody pressed anything, so the audit row has no person on it. The
          // subject is recorded so the check shows up as the name fill it is, not as a person's
          // receipt lookup.
          await deps.moneyOut.lookup(c.receipt, { personId: null, ip: 'studio' }, { subject: 'name_fill' });
          asked += 1;
        } catch (e) {
          const code = e instanceof HttpError ? e.code : null;
          // Already asked a moment ago: not a failure, just not this run's turn.
          if (code === 'lookup_in_flight') { skipped += 1; continue; }
          // Studio and the other system on this Daraja app mint tokens that kill each other's. The
          // next run gets a fresh one, so this stops the batch rather than failing the receipt.
          if (code === 'daraja_auth') { stopped = 'auth'; break; }
          // Studio is not ready to ask yet (no public address, no operator): stop, and say so.
          if (code === 'public_url_unverified' || code === 'no_operator' || code === 'not_ready') { stopped = 'not_ready'; break; }
          // Anything else Safaricom said: stop the run, leave the rest for the next one.
          stopped = 'safaricom';
          skipped += 1;
          break;
        }
        if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      }

      return { asked, skipped, remaining: (await missing(1000)).length, stopped };
    },
  };
}
