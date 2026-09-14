import { parseBalanceResult } from '@kepas/daraja-js';
import type { PoolClient } from 'pg';
import type { CallbackHandler, CallbackVerdict } from './router.js';
import type { Env } from '../settings/store.js';
import { explain } from '../sdk/meaning.js';
import { RECOVERY_TICKET_SECONDS, recoveryCacheKey } from '../auth/recoveryTicket.js';

const toCents = (n: number | undefined): number | null => (n === undefined ? null : Math.round(n * 100));

type TxOutcome =
  | { verdict: 'unmatched' | 'off_range' }
  | { verdict: 'duplicate'; requestId: string }
  | { verdict: 'applied'; requestId: string; subtype: string | null; operatorId: string | null;
      verifiedOrgId: string | null; verifiedEnv: Env | null; recovery: { recoveryId: string; personId: string } | null };

type BalanceRow = { id: string; subtype: string | null; operator_id: string | null; payload_json: unknown; environment: Env | null };

const matchingIds = "((r.originator_conversation_id = $1 AND $1 <> '') OR (r.conversation_id = $2 AND $2 <> ''))";

function requiresProductionSource(row: Pick<BalanceRow, 'subtype' | 'environment'>, selected: Env): boolean {
  // A deleted operator cannot provide evidence that a probe was a Sandbox operation.
  return (row.subtype === 'operator_probe' ? row.environment ?? 'production' : selected) === 'production';
}

/** The live balance row this result answers, matched by whichever id Safaricom's result actually
 * carries. Most refresh rows keep the ack's own OriginatorConversationID, but the uuid-fallback
 * row (money_out/service.ts, D3 — used when that ack came back empty) never had one Safaricom
 * would recognise, so it can only ever be found again by `conversation_id` — mirroring
 * `callbacks/status.ts`'s own ordered-id matching. `FOR UPDATE SKIP LOCKED` also mirrors it: a
 * concurrent handler already finalising this exact row must not make this lookup see nothing and
 * wrongly fall through past a row that is, in fact, live. */
async function findLiveBalanceRow(c: PoolClient, oc: string, convId: string): Promise<BalanceRow | null> {
  const live = await c.query<BalanceRow>(
    `SELECT r.id, r.subtype, r.operator_id, r.payload_json, o.environment FROM requests r
     LEFT JOIN operators o ON o.id=r.operator_id
     WHERE r.type='balance' AND r.status IN ('sent','unknown') AND ${matchingIds}
     ORDER BY r.created_at ASC LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
    [oc, convId]);
  return live.rows[0] ?? null;
}

/** Whether either id names an already-answered (non-live) balance row — a true redelivery. Only
 * meaningful once a live search on the same ids has already come up empty. */
async function findAnyBalanceRow(c: PoolClient, oc: string, convId: string): Promise<{ id: string } | null> {
  const any = await c.query<{ id: string }>(
    `SELECT r.id FROM requests r WHERE r.type='balance' AND ${matchingIds} LIMIT 1`,
    [oc, convId]);
  return any.rows[0] ?? null;
}

export const balanceHandler: CallbackHandler = async ({ db, cache, events, body, sourcePolicy }) => {
  const r = parseBalanceResult(body);
  const oc = r.originatorConversationId || '';
  const convId = r.conversationId || '';
  // Neither id present: nothing to match on at all (raw is already stored, 200 already acked by
  // the router regardless of what this handler returns).
  if (!oc && !convId) return { verdict: !sourcePolicy.inAllowlist && sourcePolicy.environment === 'production' ? 'off_range' : 'unmatched' };
  const ex = explain('balance', r.resultCode, r.resultDesc);

  // The SELECT ... FOR UPDATE is the atomicity boundary: two identical callbacks racing for the
  // same row serialize on that row's lock, and the loser's SKIP LOCKED search comes back empty,
  // falling through to the unlocked `findAnyBalanceRow` check and reporting 'duplicate' — it never
  // reaches the UPDATE below. Doing the balances insert and operator update on the same client,
  // inside the same transaction, keeps "one applied callback → exactly one balances row" true even
  // if a later statement in the transaction fails (the whole thing rolls back, nothing half-applies).
  const outcome: TxOutcome = await db.tx(async (c) => {
    if (!sourcePolicy.inAllowlist) {
      // Check every candidate, including completed requests: neither a duplicate nor mixed
      // identifiers can let a Production probe borrow Sandbox's relaxed source checks.
      const candidates = await c.query<Pick<BalanceRow, 'subtype' | 'environment'>>(
        `SELECT r.subtype, o.environment FROM requests r LEFT JOIN operators o ON o.id=r.operator_id
         WHERE r.type='balance' AND ${matchingIds}`, [oc, convId],
      );
      if (candidates.rows.length === 0 ? sourcePolicy.environment === 'production'
        : candidates.rows.some((row) => requiresProductionSource(row, sourcePolicy.environment))) {
        return { verdict: 'off_range' as const };
      }
    }
    const found = await findLiveBalanceRow(c, oc, convId);
    if (!found) {
      const match = await findAnyBalanceRow(c, oc, convId);
      return match ? { verdict: 'duplicate' as const, requestId: match.id } : { verdict: 'unmatched' as const };
    }
    if (!sourcePolicy.inAllowlist && requiresProductionSource(found, sourcePolicy.environment)) return { verdict: 'off_range' as const };

    let verifiedOrgId: string | null = null;
    let verifiedEnv: Env | null = null;
    let appliedOperatorId: string | null = null;
    if (found.subtype === 'operator_probe') {
      // Whether this is the probe the organisation is actually waiting on. Meaningful only while
      // the organisation is mid-sign-up (`operator_probing`) — outside that window every probe
      // (Settings' own "Test again", a rotation) is free to update its own operator regardless of
      // `setup.probeRequestId`, which belongs to sign-up alone. While it is, a sibling operator's
      // late result must touch neither that operator's own row nor the organisation: the two
      // would otherwise disagree about what "signed up" even means.
      const [waiting] = (await c.query<{ probe_request_id: string | null }>(
        `SELECT (SELECT value FROM settings WHERE org_id = app_current_org() AND key = 'setup.probeRequestId') AS probe_request_id
           FROM orgs WHERE id = app_current_org() AND status = 'operator_probing'`,
      )).rows;
      const isCurrentProbe = !waiting || waiting.probe_request_id === found.id;

      let updatedOperator: { environment: Env; status: string } | undefined;
      if (found.operator_id && isCurrentProbe) {
        const payload = found.payload_json && typeof found.payload_json === 'object'
          ? found.payload_json as { operatorRotatedAt?: unknown } : null;
        const generation = typeof payload?.operatorRotatedAt === 'string' ? payload.operatorRotatedAt : null;
        const operator = await c.query<{ environment: Env; status: string }>(
          `UPDATE operators
           SET status=$2, last_probe_at=now(), last_error=$3
           WHERE id=$1 AND status <> 'disabled'
             AND (($4::timestamptz IS NOT NULL AND rotated_at IS NOT DISTINCT FROM $4::timestamptz)
                  OR ($4::timestamptz IS NULL AND EXISTS (
                    SELECT 1 FROM requests WHERE id=$5 AND COALESCE(sent_at, created_at) >= operators.rotated_at
                  )))
           RETURNING environment, status`,
          [found.operator_id, r.success ? 'verified' : 'failed', r.success ? null : r.resultDesc, generation, found.id],
        );
        updatedOperator = operator.rows[0];
        if (updatedOperator) appliedOperatorId = found.operator_id;
      }

      if (!updatedOperator) {
        await c.query(`UPDATE requests SET status='cancelled' WHERE id=$1`, [found.id]);
        return { verdict: 'duplicate' as const, requestId: found.id };
      }

      // Sign-up's whole proof of identity (spec 4.3): Safaricom answered a live request for
      // this organisation at this organisation's own callback address. The status guard above
      // is what keeps this a no-op everywhere else — a single-mode organisation is never
      // `operator_probing`, and a re-probe of an already verified organisation changes nothing.
      if (r.success) {
        await c.query(
          `INSERT INTO org_environment_verifications (org_id, environment, verified_at)
           VALUES (app_current_org(), $1, now())
           ON CONFLICT (org_id, environment) DO NOTHING`,
          [updatedOperator.environment],
        );
        const done = await c.query<{ id: string }>(
          `UPDATE orgs SET status='verified', verified_at=now(), fail_reason=NULL
            WHERE id = app_current_org() AND status = 'operator_probing' RETURNING id`,
        );
        const row = done.rows[0];
        if (row) {
          verifiedOrgId = row.id;
          verifiedEnv = updatedOperator.environment;
          await c.query(
            `INSERT INTO settings(key, value, encrypted) VALUES ('setup.completedAt', $1, false)
             ON CONFLICT (org_id, key) DO NOTHING`,
            [new Date().toISOString()],
          );
        }
      } else {
        // The three lines, never merged, in the order the product always shows them.
        // Safaricom's own line is capped the same way operators/service.ts caps last_error.
        await c.query(
          `UPDATE orgs SET status='failed', fail_reason=$1
            WHERE id = app_current_org() AND status = 'operator_probing'`,
          [[ex.safaricomSaid.slice(0, 500), ex.meaning, ex.whatToDo].join('\n')],
        );
      }
    }
    await c.query(
      `UPDATE requests SET status=$2, conversation_id=$3, result_at=now(), result_source='callback', result_code=$4, result_desc=$5,
         meaning=$6, retriable=$7, raw_result_json=$8::jsonb
       WHERE id=$1`,
      [found.id, r.success ? 'completed' : 'failed', r.conversationId, String(r.resultCode), r.resultDesc, ex.meaning, ex.retriable, JSON.stringify(body)],
    );

    // A recovery probe answers no dashboard: its balances are never the account's own current
    // figures to anyone but the one caller asking, and are not what "balance.updated" means.
    if (r.success && found.subtype !== 'recovery_probe') {
      const find = (name: string) => r.balances.find((b) => b.account.toLowerCase().startsWith(name));
      await c.query(
        `INSERT INTO balances(working_cents, utility_cents, charges_paid_cents, raw) VALUES ($1,$2,$3,$4::jsonb)`,
        [toCents(find('working')?.availableBalance), toCents(find('utility')?.availableBalance), toCents(find('charges')?.availableBalance), JSON.stringify(r.balances)],
      );
    }
    // Never publish `operator.updated` for a row this callback did not actually touch.
    const operatorId = appliedOperatorId;

    // Owner recovery (spec 5.4): Safaricom answered a live request with the operator password the
    // caller typed, which is the whole proof. The ticket is what /api/auth/recover/finish spends.
    let recovery: { recoveryId: string; personId: string } | null = null;
    if (found.subtype === 'recovery_probe' && r.success) {
      const payload = found.payload_json as { recoveryId?: unknown; personId?: unknown } | null;
      if (typeof payload?.recoveryId === 'string' && typeof payload?.personId === 'string') {
        recovery = { recoveryId: payload.recoveryId, personId: payload.personId };
      }
    }
    return { verdict: 'applied' as const, requestId: found.id, subtype: found.subtype, operatorId, verifiedOrgId, verifiedEnv, recovery };
  });

  if (outcome.verdict !== 'applied') return outcome satisfies CallbackVerdict;

  if (r.success && outcome.subtype !== 'recovery_probe') await events.publish('balance.updated', { at: new Date().toISOString() });
  if (outcome.subtype === 'operator_probe' && outcome.operatorId) {
    await events.publish('operator.updated', { operatorId: outcome.operatorId, status: r.success ? 'verified' : 'failed' });
  }
  // A single-mode organisation is never `operator_probing`, so the guard this outcome came from
  // never matches and verifiedOrgId is always null here — kept rather than deleted because the
  // guard itself protects a real invariant (a re-probe of an already-verified install changes
  // nothing) and nothing downstream reads verifiedOrgId once org.updated is published.
  if (outcome.verifiedOrgId) {
    await events.publish('org.updated', { id: outcome.verifiedOrgId, status: 'verified' });
  }
  if (outcome.recovery) {
    await cache.set(recoveryCacheKey(outcome.recovery.recoveryId), { personId: outcome.recovery.personId }, RECOVERY_TICKET_SECONDS);
  }
  await events.publish('request.updated', { id: outcome.requestId, status: r.success ? 'completed' : 'failed' });
  return { verdict: 'applied', requestId: outcome.requestId };
};
