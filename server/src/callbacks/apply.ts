import type { Db } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { CallbackVerdict } from './router.js';
import { kindsForPath, type RequestKind } from '../money_out/registry.js';
import { explain } from '../sdk/meaning.js';
import { failOperatorOnCredentialCode } from '../money_out/operatorHealth.js';

/**
 * B0: one result application for every money-out kind.
 *
 * A callback address is not a request kind. Several kinds answer on `/b2b` (a paybill payment, a
 * float transfer, a till top-up, a tax remittance) and two answer on `/b2c` (a phone send and a
 * business-wallet send). So the row is resolved first, by the identifiers Safaricom returns, and
 * only among the kinds that actually answer on the path the result arrived at. A result posted to
 * the wrong path therefore matches nothing and is never applied to a row of a different kind.
 *
 * Identity is read with the path's own parser: kinds sharing a path share Safaricom's result shape,
 * which is a property of the API, not of what we called it. Once the row is known, its own kind
 * re-parses the body so kind-specific fields are read by the kind that understands them.
 */
export async function applyResult(
  deps: { db: Db; events: EventHub },
  path: RequestKind['callbackPath'],
  body: unknown,
): Promise<CallbackVerdict> {
  const kinds = kindsForPath(path);
  if (kinds.length === 0) return { verdict: 'unmatched' };
  const types = kinds.map((k) => k.type);

  // Which row this result names, before we know which kind wrote it. Kinds sharing a path normally
  // share Safaricom's envelope, but the first kind in the map is not guaranteed to be one that can
  // read this body, so each reader is tried until one succeeds rather than trusting map order. A
  // body no reader on this path understands names no row and is never applied.
  let identity: ReturnType<RequestKind['parseResult']> | null = null;
  for (const k of kinds) {
    try { identity = k.parseResult(body); break; } catch { /* not this kind's envelope; try the next */ }
  }
  if (!identity) return { verdict: 'unmatched' };

  type Outcome =
    | { verdict: 'unmatched' }
    | { verdict: 'duplicate'; requestId: string }
    | { verdict: 'applied'; requestId: string; operatorId: string | null; funds: boolean; success: boolean; resultCode: number; resultDesc: string };

  const outcome: Outcome = await deps.db.tx(async (c) => {
    // Which row this is, before anything is written: the match is on either identifier because a
    // kind whose API assigns its own OriginatorConversationID stores it as
    // payload_json->>'ackOriginatorConversationId', while a kind that supplies ours matches
    // originator_conversation_id directly. Both are covered without the caller knowing which.
    const found = await c.query<{ id: string; type: string; operator_id: string | null; status: string }>(
      `SELECT id, type, operator_id, status FROM requests
        WHERE (originator_conversation_id=$1 OR payload_json->>'ackOriginatorConversationId'=$1) AND type = ANY($2)
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [identity.originatorConversationId, types]);
    const row = found.rows[0];
    if (!row) return { verdict: 'unmatched' as const };

    // The row's own kind owns the reading of its result. A kind that shares this path but is not
    // this row's kind never gets to interpret it.
    const kind = kinds.find((k) => k.type === row.type);
    if (!kind) return { verdict: 'unmatched' as const };
    const r = kind.parseResult(body);
    const ex = explain(kind.scope, r.resultCode, r.resultDesc);
    const hasFunds = r.success && (r.utilityCents != null || r.workingCents != null);

    const upd = await c.query<{ id: string }>(
      `UPDATE requests SET status=$2, conversation_id=COALESCE(conversation_id,$3), result_at=now(), result_source='callback',
         result_code=$4, result_desc=$5, meaning=$6, retriable=$7, receipt=COALESCE($8, receipt), recipient_name=COALESCE($9, recipient_name), raw_result_json=$10::jsonb
       WHERE id=$1 AND status IN ('pending','sent','unknown')
       RETURNING id`,
      [row.id, r.success ? 'completed' : 'failed', r.conversationId || null, String(r.resultCode), r.resultDesc, ex.meaning, ex.retriable,
        r.receipt ?? null, r.recipientName ?? null, JSON.stringify(body)]);
    if (!upd.rows[0]) return { verdict: 'duplicate' as const, requestId: row.id };

    if (hasFunds) {
      await c.query(`INSERT INTO balances(working_cents, utility_cents, charges_paid_cents, raw) VALUES ($1,$2,NULL,$3::jsonb)`,
        [r.workingCents ?? null, r.utilityCents ?? null, JSON.stringify({ source: `${kind.type}_result`, utilityCents: r.utilityCents ?? null, workingCents: r.workingCents ?? null })]);
    }
    return { verdict: 'applied' as const, requestId: row.id, operatorId: row.operator_id, funds: hasFunds, success: r.success, resultCode: r.resultCode, resultDesc: r.resultDesc };
  });

  if (outcome.verdict !== 'applied') return outcome satisfies CallbackVerdict;
  if (!outcome.success) await failOperatorOnCredentialCode(deps.db, deps.events, outcome.operatorId, outcome.resultCode, outcome.resultDesc);
  if (outcome.funds) await deps.events.publish('balance.updated', { at: new Date().toISOString() });
  await deps.events.publish('request.updated', { id: outcome.requestId, status: outcome.success ? 'completed' : 'failed' });
  return { verdict: 'applied', requestId: outcome.requestId };
}
