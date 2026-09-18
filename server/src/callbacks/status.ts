import { parseStatusResult } from '@kepas/daraja-js';
import type { PoolClient } from 'pg';
import type { CallbackHandler, CallbackVerdict } from './router.js';
import { explain } from '../sdk/meaning.js';
import { directionOf, LEDGER_TYPES, MONEY_TYPES } from '../money_out/registry.js';
import { personName } from '../util/names.js';
import { scheduleBalanceRefresh } from '../money_out/balanceRefresh.js';

export const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled', 'reversed', 'expired', 'declined', 'rejected']);
const FINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const LIVE = new Set(['sent', 'pending', 'unknown']);
const LIVE_QUERY = `type='status_query' AND status IN ('sent','unknown')`;

type QueryRow = { id: string; subtype: string | null; recipient_value: string | null; payload_json: { targetRequestId?: string } };

/** A live query row by `conversation_id` alone — the only key Safaricom assigns per individual
 * query. `SKIP LOCKED` so a concurrent handler already finalising this exact row does not
 * make this lookup see nothing and wrongly fall through past a row that is, in fact, live. */
async function findLiveByConversationId(c: PoolClient, convId: string): Promise<QueryRow | null> {
  const live = await c.query<QueryRow>(
    `SELECT id, subtype, recipient_value, payload_json FROM requests WHERE ${LIVE_QUERY} AND conversation_id = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [convId]);
  return live.rows[0] ?? null;
}

/** Whether `conversation_id` names an already-answered (non-live) query — a true redelivery. It
 * only tells the two apart once a live search on the same id has already come up empty. */
async function findFinalByConversationId(c: PoolClient, convId: string): Promise<{ id: string } | null> {
  const final = await c.query<{ id: string }>(
    `SELECT id FROM requests WHERE type='status_query' AND conversation_id = $1`, [convId]);
  return final.rows[0] ?? null;
}

/** A live query row by the two OriginatorConversationID keys — used only when the result carries
 * no `conversation_id` at all. Both keys are shared across every outstanding query of the same
 * payment, so the oldest live row is taken deterministically. */
async function findLiveByOcid(c: PoolClient, oc: string): Promise<QueryRow | null> {
  const byAck = await c.query<QueryRow>(
    `SELECT id, subtype, recipient_value, payload_json FROM requests WHERE ${LIVE_QUERY} AND payload_json->>'ackOriginatorConversationId' = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [oc]);
  if (byAck.rows[0]) return byAck.rows[0];
  const byOwn = await c.query<QueryRow>(
    `SELECT id, subtype, recipient_value, payload_json FROM requests WHERE ${LIVE_QUERY} AND originator_conversation_id = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [oc]);
  return byOwn.rows[0] ?? null;
}

type Outcome =
  | { verdict: 'unmatched' }
  | { verdict: 'duplicate'; requestId: string }
  | { verdict: 'unmatched_final'; targetId: string }
  | { verdict: 'direct_unclear'; targetId: string }
  | { verdict: 'applied_direct'; targetId: string; applied: 'completed' | 'failed' }
  | { verdict: 'applied'; requestId: string; targetId: string | null; applied: 'completed' | 'failed' | null; disagreed: boolean; unclear: boolean; amountMismatch: boolean };

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export const statusHandler: CallbackHandler = async ({ db, events, body }) => {
  const r = parseStatusResult(body);
  const oc = r.originatorConversationId || '';
  const convId = r.conversationId || '';
  // Neither id present: nothing to match on at all (raw is already stored, 200 already acked by
  // the router regardless of what this handler returns).
  if (!oc && !convId) return { verdict: 'unmatched' };

  const ex = explain('status', r.resultCode, r.resultDesc);
  const transactionStatus = r.transactionStatus ?? null;
  // Phase A: Safaricom names both sides of the transaction, each as "phone - NAME". Which one is
  // the person depends on which way the money moved — money in names the payer on the debit side,
  // money out the person paid on the credit side — so the choice follows the row's own direction. A
  // row whose direction Studio cannot tell keeps the credit party, which is what this handler has
  // always stored.
  const creditParty = personName(str(r.params.CreditPartyName ?? r.params['Credit Party Name']));
  const debitParty = personName(str(r.params.DebitPartyName ?? r.params['Debit Party Name']));
  const partyFor = (type: string | null | undefined): string | null => {
    const direction = directionOf(type ?? '');
    if (direction === 'in') return debitParty;
    if (direction === 'out') return creditParty;
    return creditParty ?? debitParty;
  };
  const amountCents = r.params.Amount != null && Number.isFinite(Number(r.params.Amount)) ? Math.round(Number(r.params.Amount) * 100) : null;
  const queryMeaning = r.success && transactionStatus ? `Safaricom reports this transaction as ${transactionStatus}.` : ex.meaning;
  const st = (transactionStatus ?? '').toLowerCase();
  const applied: 'completed' | 'failed' | null = !r.success ? null : st === 'completed' ? 'completed' : FAILED_STATUSES.has(st) ? 'failed' : null;

  const outcome: Outcome = await db.tx(async (c) => {
    // A non-empty conversation_id is decisive on its own: once present, it is resolved to
    // live/duplicate/none using ONLY that id — never falling back to the OCID keys, which are
    // shared across every outstanding query of the same payment and would let a redelivery of an
    // already-answered query hijack a different, still-live one. The OCID keys are tried at all
    // only when the result carries no conversation_id whatsoever.
    const found = convId ? await findLiveByConversationId(c, convId) : await findLiveByOcid(c, oc);

    if (!found) {
      if (convId) {
        const finalMatch = await findFinalByConversationId(c, convId);
        if (finalMatch) return { verdict: 'duplicate' as const, requestId: finalMatch.id };
      }
      if (!oc) return { verdict: 'unmatched' as const };

      // Neither a live nor a final query row answers this result. Safaricom queries (and echoes
      // back) the ORIGINAL transaction's own OriginatorConversationID, so if pollTarget's own
      // INSERT never landed (C1's "process died between the ack and our INSERT"), the money row
      // itself can still be found directly by that same id.
      const money = await c.query<{ id: string; type: string; status: string; amount_cents: string | null }>(
        `SELECT id, type, status, amount_cents FROM requests WHERE type = ANY($1) AND (originator_conversation_id = $2 OR payload_json->>'ackOriginatorConversationId' = $2) ORDER BY created_at ASC LIMIT 1 FOR UPDATE`, [MONEY_TYPES, oc]);
      const m = money.rows[0];
      if (!m) return { verdict: 'unmatched' as const };
      if (!LIVE.has(m.status)) return { verdict: 'unmatched_final' as const, targetId: m.id };
      if (!applied) return { verdict: 'direct_unclear' as const, targetId: m.id };

      await c.query(
        `UPDATE requests SET status=$2, result_at=now(), result_source='poll', result_code=NULL, result_desc=$3, meaning=$4, retriable=false,
           receipt=COALESCE($5, receipt), recipient_name=COALESCE($6, recipient_name)
         WHERE id=$1`,
        [m.id, applied, transactionStatus, `Safaricom's own record of this payment says: ${transactionStatus}.`, applied === 'completed' ? (r.receipt ?? null) : null, partyFor(m.type)]);
      return { verdict: 'applied_direct' as const, targetId: m.id, applied };
    }

    // Phase A: a receipt lookup is the one query row with no target of ours, and it is how a payment
    // Safaricom never confirmed gets its name back. When Studio already holds the row that receipt
    // belongs to, that row's own direction picks which of Safaricom's two names is the person, and
    // the name is written onto it — but only where it has none, so a name already known is never
    // overwritten. Only the name is touched: status, amount and receipt are left alone, which is why
    // migration 004's final-row guard lets this through.
    let queryParty: string | null = creditParty;
    if (found.subtype === 'lookup' && found.recipient_value) {
      const [held] = (await c.query<{ id: string; type: string; recipient_name: string | null }>(
        `SELECT id, type, recipient_name FROM requests WHERE receipt=$1 AND type = ANY($2) ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
        [found.recipient_value, LEDGER_TYPES])).rows;
      if (held) {
        queryParty = partyFor(held.type);
        if (queryParty && personName(held.recipient_name) === null) {
          await c.query(`UPDATE requests SET recipient_name=$2 WHERE id=$1`, [held.id, queryParty]);
        }
      }
    }

    const query = await c.query<{ id: string }>(
      `UPDATE requests SET status=$2, result_at=now(), result_source='callback', result_code=$3, result_desc=$4, meaning=$5, retriable=$6,
         raw_result_json=$7::jsonb, receipt=COALESCE($8, receipt), recipient_name=COALESCE($9, recipient_name), amount_cents=COALESCE($10, amount_cents)
       WHERE id=$1 RETURNING id`,
      [found.id, r.success ? 'completed' : 'failed', String(r.resultCode), r.resultDesc, queryMeaning, ex.retriable, JSON.stringify(body), r.receipt ?? null, queryParty, amountCents]);
    const queryId = query.rows[0].id;

    const targetId = found.payload_json.targetRequestId ?? null;
    if (!targetId) return { verdict: 'applied' as const, requestId: queryId, targetId: null, applied: null, disagreed: false, unclear: false, amountMismatch: false };
    if (!applied) return { verdict: 'applied' as const, requestId: queryId, targetId, applied: null, disagreed: false, unclear: r.success, amountMismatch: false };

    const t = await c.query<{ status: string; type: string; amount_cents: string | null }>('SELECT status, type, amount_cents FROM requests WHERE id=$1 FOR UPDATE', [targetId]);
    const current = t.rows[0];
    if (!current) return { verdict: 'applied' as const, requestId: queryId, targetId, applied: null, disagreed: false, unclear: true, amountMismatch: false };
    const disagreed = FINAL.has(current.status) && current.status !== applied;
    if (FINAL.has(current.status) && !disagreed) return { verdict: 'applied' as const, requestId: queryId, targetId, applied: null, disagreed: false, unclear: false, amountMismatch: false };

    const existingAmount = current.amount_cents === null ? null : Number(current.amount_cents);
    const amountMismatch = existingAmount !== null && amountCents !== null && existingAmount !== amountCents;

    // Poll is authoritative (parent spec §10). result_code stays NULL for a poll-derived outcome:
    // the code belongs to the query, not the payment; Safaricom's word for the payment is the
    // TransactionStatus text, stored verbatim as result_desc. An amount disagreement is
    // still applied — never overwriting amount_cents itself — but flagged for a human.
    await c.query(
      `UPDATE requests SET status=$2, result_at=now(), result_source='poll', result_code=NULL, result_desc=$3, meaning=$4, retriable=false,
         receipt=COALESCE($5, receipt), recipient_name=COALESCE($6, recipient_name)
       WHERE id=$1`,
      [targetId, applied, transactionStatus, `Safaricom's own record of this payment says: ${transactionStatus}.`, applied === 'completed' ? (r.receipt ?? null) : null, partyFor(current.type)]);
    return { verdict: 'applied' as const, requestId: queryId, targetId, applied, disagreed, unclear: false, amountMismatch };
  });

  if (outcome.verdict === 'unmatched' || outcome.verdict === 'duplicate') return outcome satisfies CallbackVerdict;

  if (outcome.verdict === 'unmatched_final') {
    // A result named a money row directly, but that row is already final and this result was
    // never tied to any of our own query rows — too weak a match to override a final outcome.
    await events.publish('alert', { kind: 'status_result_for_final', id: outcome.targetId });
    return { verdict: 'unmatched_final', requestId: outcome.targetId };
  }

  if (outcome.verdict === 'direct_unclear') {
    // Nothing was written — the direct path only claims `applied_direct` when it actually wrote.
    await events.publish('alert', { kind: 'status_unclear', id: outcome.targetId });
    return { verdict: 'unmatched', requestId: outcome.targetId };
  }

  if (outcome.verdict === 'applied_direct') {
    await events.publish('alert', { kind: 'status_query_unrecorded', id: outcome.targetId });
    await events.publish('request.updated', { id: outcome.targetId, status: outcome.applied });
    // Feature 9: a payment recovered by a poll finished here, not in apply.ts, so the balance is
    // asked for again on this path too. The helper collapses repeats into one query a minute.
    await scheduleBalanceRefresh(db);
    return { verdict: 'applied_direct', requestId: outcome.targetId };
  }

  // The query row's own status just changed too — a UI list of status checks needs this,
  // independent of whether it also had a target.
  await events.publish('request.updated', { id: outcome.requestId, status: r.success ? 'completed' : 'failed' });
  if (outcome.targetId !== null) {
    if (outcome.applied) {
      if (outcome.disagreed) await events.publish('alert', { kind: 'result_disagreement', id: outcome.targetId });
      if (outcome.amountMismatch) await events.publish('alert', { kind: 'status_amount_mismatch', id: outcome.targetId });
      await events.publish('request.updated', { id: outcome.targetId, status: outcome.applied });
      // Feature 9: the same settled-payment rule as apply.ts, on the poll path.
      await scheduleBalanceRefresh(db);
    } else if (outcome.unclear) {
      await events.publish('alert', { kind: 'status_unclear', id: outcome.targetId });
    }
  }
  return { verdict: 'applied', requestId: outcome.requestId };
};
