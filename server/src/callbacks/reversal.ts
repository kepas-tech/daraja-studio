import { parseReversalResult } from '@kepas/daraja-js';
import type { CallbackHandler, CallbackVerdict } from './router.js';
import { applyResult } from './apply.js';
import { REVERSAL_QUEUE_TIMEOUT, SPENT_MEANING } from '../money_out/reversal.js';

/**
 * The reversal result. The row is resolved and written by the one result path every kind uses
 * (callbacks/apply.ts); this adds the one thing only a reversal needs, which that generic path
 * cannot say.
 *
 * Rule 3: whether Safaricom could still take the money back is decided by the SDK's own classifier,
 * isSettledByRecipientSpend, because Safaricom reports "the customer already spent it" only as free
 * text and there is no stable result code for it. The meaning catalogue is keyed by result code, so
 * the generic path lands on "Safaricom did not explain this code" — true but useless. The honest
 * sentence is written here instead, and a second event tells any open page to re-read the row.
 */
export const reversalHandler: CallbackHandler = async ({ db, events, body, failover }) => {
  const verdict = await applyResult({ db, events, failover }, 'reversal', body);
  if (verdict.verdict !== 'applied' || !verdict.requestId) return verdict;
  let spent = false;
  try {
    const r = parseReversalResult(body);
    spent = !r.success && r.settledByRecipientSpend === true;
  } catch {
    // The outcome is already applied; this extra line is best effort and never changes the verdict.
  }
  if (!spent) return verdict;
  await db.query(`UPDATE requests SET meaning=$2 WHERE id=$1 AND type='reversal' AND status='failed'`, [verdict.requestId, SPENT_MEANING]);
  await events.publish('request.updated', { id: verdict.requestId, status: 'failed' });
  return verdict;
};

/**
 * Safaricom's reversal queue timeout: posted to QueueTimeOutURL when the queue does not answer in
 * time. This is not a result — the reversal may still happen — so the row is only marked unknown,
 * never failed, and is left with no result_at/result_code/result_source so the sweep still polls it
 * and a late real result can still finalise it. Same shape as the phone send's timeout handler.
 */
export const reversalTimeoutHandler: CallbackHandler = async ({ db, events, body }) => {
  const oc = (body as { Result?: { OriginatorConversationID?: string } } | null)?.Result?.OriginatorConversationID;
  if (!oc) return { verdict: 'unmatched' } satisfies CallbackVerdict;
  const upd = await db.query<{ id: string }>(
    `UPDATE requests SET status='unknown', sent_at=COALESCE(sent_at, now()), meaning=$2
     WHERE (originator_conversation_id=$1 OR payload_json->>'ackOriginatorConversationId'=$1) AND type='reversal' AND status IN ('pending','sent')
     RETURNING id`,
    [oc, REVERSAL_QUEUE_TIMEOUT]);
  const row = upd[0];
  if (!row) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM requests WHERE (originator_conversation_id=$1 OR payload_json->>'ackOriginatorConversationId'=$1) AND type='reversal'`,
      [oc]);
    return existing[0] ? { verdict: 'duplicate' as const, requestId: existing[0].id } : { verdict: 'unmatched' as const };
  }
  await events.publish('request.updated', { id: row.id, status: 'unknown' });
  await events.publish('alert', { kind: 'request_queue_timeout', id: row.id });
  return { verdict: 'applied', requestId: row.id };
};
