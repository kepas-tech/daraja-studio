import type { CallbackHandler, CallbackVerdict } from './router.js';
import { B2C_QUEUE_TIMEOUT } from '../money_out/service.js';

/**
 * Safaricom's B2C queue timeout: posted to `QueueTimeOutURL` when the payment queue does not
 * answer in time. This is not a result — the payment may still complete or fail later on the
 * normal result path (`b2cHandler`) — so the row is only marked `unknown`, never `failed`, and
 * never given a `result_at`/`result_code`/`result_source`. That keeps it eligible for the sweep's
 * due-row SELECT (`status IN ('sent','pending','unknown') ... result_at IS NULL`) and for the
 * real result to still finalise it. A timeout body may be thinner than a real result, so this
 * reads only the one field it needs rather than `parseB2cResult`.
 */
export const b2cTimeoutHandler: CallbackHandler = async ({ db, events, body }) => {
  const oc = (body as { Result?: { OriginatorConversationID?: string } } | null)?.Result?.OriginatorConversationID;
  if (!oc) return { verdict: 'unmatched' } satisfies CallbackVerdict;
  const upd = await db.query<{ id: string }>(
    `UPDATE requests SET status='unknown', sent_at=COALESCE(sent_at, now()), meaning=$2
     WHERE (originator_conversation_id=$1 OR payload_json->>'ackOriginatorConversationId'=$1) AND type='b2c' AND status IN ('pending','sent')
     RETURNING id`,
    [oc, B2C_QUEUE_TIMEOUT]);
  const row = upd[0];
  if (!row) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM requests WHERE (originator_conversation_id=$1 OR payload_json->>'ackOriginatorConversationId'=$1) AND type='b2c'`,
      [oc]);
    return existing[0] ? { verdict: 'duplicate' as const, requestId: existing[0].id } : { verdict: 'unmatched' as const };
  }
  await events.publish('request.updated', { id: row.id, status: 'unknown' });
  await events.publish('alert', { kind: 'request_queue_timeout', id: row.id });
  return { verdict: 'applied', requestId: row.id };
};
