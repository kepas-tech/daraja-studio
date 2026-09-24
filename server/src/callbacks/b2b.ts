import type { CallbackHandler, CallbackVerdict } from './router.js';
import { applyResult } from './apply.js';

export const B2B_QUEUE_TIMEOUT = "Safaricom's queue timed out before this payment was processed. Studio will check whether it went through.";

/**
 * Results for every kind that answers on the B2B address; today that is paying a paybill or a till.
 * `applyResult` resolves the row and refuses to apply the result to a kind that answers elsewhere.
 */
export const b2bHandler: CallbackHandler = async ({ db, events, body, failover }) => applyResult({ db, events, failover }, 'b2b', body);

/**
 * Safaricom's B2B queue timeout. Not a result — the payment may still complete later on the result
 * path — so the row is only marked unknown and left for the sweep, exactly as the phone send's and
 * the reversal's timeouts are.
 */
export const b2bTimeoutHandler: CallbackHandler = async ({ db, events, body }) => {
  const oc = (body as { Result?: { OriginatorConversationID?: string } } | null)?.Result?.OriginatorConversationID;
  if (!oc) return { verdict: 'unmatched' } satisfies CallbackVerdict;
  const upd = await db.query<{ id: string }>(
    `UPDATE requests SET status='unknown', sent_at=COALESCE(sent_at, now()), meaning=$2
     WHERE (originator_conversation_id=$1 OR payload_json->>'ackOriginatorConversationId'=$1) AND type='b2b' AND status IN ('pending','sent')
     RETURNING id`,
    [oc, B2B_QUEUE_TIMEOUT]);
  const row = upd[0];
  if (!row) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM requests WHERE (originator_conversation_id=$1 OR payload_json->>'ackOriginatorConversationId'=$1) AND type='b2b'`,
      [oc]);
    return existing[0] ? { verdict: 'duplicate' as const, requestId: existing[0].id } : { verdict: 'unmatched' as const };
  }
  await events.publish('request.updated', { id: row.id, status: 'unknown' });
  await events.publish('alert', { kind: 'request_queue_timeout', id: row.id });
  return { verdict: 'applied', requestId: row.id };
};
