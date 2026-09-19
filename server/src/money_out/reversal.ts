import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { DarajaAPIError, DarajaAuthError, DarajaConnectionError, isSettledByRecipientSpend } from '@kepas/daraja-js';
import type { AppDeps } from '../app.js';
import type { Db } from '../db/pool.js';
import type { Settings } from '../settings/store.js';
import type { Config } from '../config.js';
import type { DarajaFactory } from '../sdk/client.js';
import type { EventHub } from '../events/hub.js';
import type { OrgService } from '../orgs/service.js';
import { currentCallbackSecret } from '../orgs/secret.js';
import { callbackUrls } from '../sdk/callbackUrls.js';
import { explain } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { clientIp } from '../util/ip.js';
import { requireAuth, requireCsrf, requireStepUp } from '../auth/middleware.js';
import { personPermissions, requirePermission } from '../permissions/middleware.js';
import { requireModule } from '../modules/middleware.js';
import { requireMoneyReady } from './ready.js';
import { getRequest, type RequestView } from './reads.js';
import { KINDS, LEDGER_TYPES, type RequestRow } from './registry.js';
import { recordOperatorRefusal } from './operatorHealth.js';
import type { Failover } from '../callbacks/apply.js';
import { AUTH_FAILED_MEANING, UNCONFIRMED } from './service.js';

/**
 * M3: reverse a payment. The reversal call itself is one line in the kind; everything here is the
 * rules around it, because a reversal is irreversible.
 *
 * 1. There must be a payment of this organisation's own that actually settled: a completed row
 *    whose receipt matches, and whose amount we therefore know. A receipt that settled nowhere is
 *    refused before Safaricom is ever called.
 * 2. The same receipt must never be reversed twice. The advisory lock is taken first, inside the
 *    same transaction as the guard and the insert, and is keyed on the receipt exactly as the
 *    guard compares it — the same shape the send path uses, for the same reason.
 * 3. Safaricom decides whether it can still take the money back, and the answer is recorded
 *    honestly: see the classifier in callbacks/reversal.ts and the synchronous refusal below.
 */

export const NOT_SETTLED = 'Studio has no completed payment with that receipt. Only a payment that already settled can be reversed.';
export const ALREADY_REVERSED = 'This receipt is already being reversed, or has been. A payment can only be taken back once.';
export const REVERSAL_QUEUE_TIMEOUT = "Safaricom's queue timed out before this reversal was processed. Studio will check whether it happened.";
/** The SDK's own classifier decides this; the sentence below is what the operator reads. */
export const SPENT_MEANING = 'The customer has already spent this money, so Safaricom cannot take it back. Nothing was reversed — treat the original payment as settled, and if the money must come back, agree another way to collect it.';

const DUP_ID = 'Duplicate OriginatorConversationID';
const RECEIPT_RE = /^[A-Z0-9]{10}$/;

/** What the operator sees before deciding: the payment that would be taken back. */
export interface SettledPayment { requestId: string; receipt: string; amountCents: number; at: string; type: string }

/**
 * Safaricom's own code and text from a synchronous rejection. The SDK's errorFromResponse only
 * sets resultCode/resultDesc when the caller passed them explicitly (our own ack check does); a
 * real Daraja sync rejection carries them on the error's raw payload instead, which is never read
 * for anything except these two fields.
 */
function syncRejection(e: DarajaAPIError): { code: string | null; desc: string } {
  if (e.resultCode != null) return { code: String(e.resultCode), desc: e.resultDesc ?? e.message };
  const raw = (e as { raw?: unknown }).raw;
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const code = typeof o.ResponseCode === 'string' ? o.ResponseCode : typeof o.errorCode === 'string' ? o.errorCode : null;
  const desc = e.resultDesc ?? (typeof o.ResponseDescription === 'string' ? o.ResponseDescription : typeof o.errorMessage === 'string' ? o.errorMessage : e.message);
  return { code, desc };
}

/** The completed payment a receipt names, or null. RLS keeps this inside the caller's organisation. */
export async function findSettledPayment(db: Db, receipt: string): Promise<SettledPayment | null> {
  const rows = await db.query<{ id: string; receipt: string; amount_cents: string; result_at: Date | null; created_at: Date; type: string }>(
    `SELECT id, receipt, amount_cents, result_at, created_at, type FROM requests
      WHERE receipt = $1 AND status = 'completed' AND amount_cents IS NOT NULL AND amount_cents > 0 AND type = ANY($2)
      ORDER BY result_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [receipt, LEDGER_TYPES]);
  const r = rows[0];
  if (!r) return null;
  return { requestId: r.id, receipt: r.receipt, amountCents: Number(r.amount_cents), at: (r.result_at ?? r.created_at).toISOString(), type: r.type };
}

export interface ReversalService {
  find(receipt: string): Promise<SettledPayment | null>;
  /**
   * Round 3, phase D-6: `hold` writes the request and stops — it waits for somebody else to
   * approve it, exactly as a send above the approval threshold does. A person who may approve
   * their own request gets the reversal sent straight away.
   */
  request(input: { receipt: string; remarks?: string }, actor: { personId: string; ip: string }, opts?: { hold?: boolean }): Promise<RequestView>;
}

export function createReversalService(deps: { db: Db; settings: Settings; daraja: DarajaFactory; events: EventHub; config: Config; orgs: OrgService; /** Brief 2, item 7. */ failover?: Failover }): ReversalService {
  async function urls() {
    const publicUrl = await deps.settings.get('public.url');
    if (!publicUrl) throw new HttpError(409, 'public_url_unverified', 'Test your public address in Settings first.');
    return callbackUrls(publicUrl, await currentCallbackSecret(deps.orgs));
  }

  return {
    find: (receipt) => findSettledPayment(deps.db, receipt),

    async request(input, actor, opts) {
      const receipt = input.receipt.trim().toUpperCase();
      if (!RECEIPT_RE.test(receipt)) throw new HttpError(400, 'bad_receipt', 'An M-Pesa receipt is 10 letters and numbers, like RI6BZTPXNM.');

      // Rule 1, before any call: the money must actually have settled here, and the amount comes
      // from that payment rather than from whoever is typing. A reversal is not a second send.
      const settled = await findSettledPayment(deps.db, receipt);
      if (!settled) throw new HttpError(409, 'not_settled', NOT_SETTLED);

      const kind = KINDS.reversal;
      if (!kind) throw new HttpError(500, 'not_configured', 'Reversals are not available in this build.');
      const cb = await urls();
      const client = await deps.daraja.getForOperator();
      const operatorId = (await deps.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [client.config?.initiator ?? '']))[0]?.id ?? null;

      // Rule 2. The lock key and the guard's comparison both come from the kind, so the two can
      // never disagree about what "the same reversal" means. The request exists before Safaricom
      // hears of it, exactly as on the send path.
      const row = await deps.db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [kind.dupKey({ type: kind.type, recipient_value: receipt, amount_cents: String(settled.amountCents), payload_json: {} })]);
        const existing = await c.query<{ id: string; created_at: Date }>(
          `SELECT id, created_at FROM requests WHERE type=$1 AND recipient_value IS NOT DISTINCT FROM $2
             AND status NOT IN ('failed','cancelled','rejected') ORDER BY created_at DESC LIMIT 1`,
          [kind.type, receipt]);
        const prior = existing.rows[0];
        if (prior) throw new HttpError(409, 'already_reversed', ALREADY_REVERSED, { requestId: prior.id, at: prior.created_at.toISOString() });
        const { rows } = await c.query<RequestRow>(
          `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, remarks, payload_json, created_by, operator_id)
           VALUES ($1,'TransactionReversal',$2,'pending',$3,'KES','receipt',$4,$5,$6::jsonb,$7,$8) RETURNING *`,
          [kind.type, randomUUID(), settled.amountCents, receipt, input.remarks ?? null,
            JSON.stringify({ reversalOfRequestId: settled.requestId, originalType: settled.type }), actor.personId, operatorId]);
        const r = rows[0];
        if (!r) throw new HttpError(500, 'not_recorded', 'Studio could not record the reversal.');
        await c.query(
          `INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip) VALUES ($1,'reversal.requested',$2,$3::jsonb,$4::jsonb,$5)`,
          [actor.personId, r.id, null, JSON.stringify({ amountCents: settled.amountCents, reversalOfRequestId: settled.requestId }), actor.ip]);
        return r;
      });

      // M4, for reversals (phase D-6): somebody who may ask but not approve only asks. The row
      // drops its operator and waits, and the Waiting page's Release sends it down exactly the
      // path a direct reversal takes, so there is one way to Safaricom, not two.
      if (opts?.hold) {
        await deps.db.query(`UPDATE requests SET status='awaiting_approval', operator_id=NULL WHERE id=$1 AND status='pending'`, [row.id]);
        await deps.db.query(
          `INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip) VALUES ($1,'request.held',$2,$3::jsonb,$4::jsonb,$5)`,
          [actor.personId, row.id, null, JSON.stringify({ type: kind.type, amountCents: settled.amountCents, reversalOfRequestId: settled.requestId, reason: 'reversal_request' }), actor.ip]);
        await deps.events.publish('request.updated', { id: row.id, status: 'awaiting_approval' });
        const held = await getRequest(deps.db, row.id, deps.config.egressIps);
        if (!held) throw new HttpError(500, 'not_recorded', 'Studio could not read back the reversal it recorded.');
        return held;
      }

      let status: string;
      try {
        const ack = await kind.send(client, row, cb);
        if (ack.responseCode !== '0') throw new DarajaAPIError(ack.responseDescription, { resultCode: Number(ack.responseCode), resultDesc: ack.responseDescription, scope: kind.scope });
        // Safaricom's reversal API takes no OriginatorConversationID from us, so its ack carries
        // Safaricom's own. The result callback echoes that, and matching falls back to this field.
        const patch: Record<string, unknown> = {};
        if (ack.originatorConversationId && ack.originatorConversationId !== row.originator_conversation_id) patch.ackOriginatorConversationId = ack.originatorConversationId;
        await deps.db.query(
          `UPDATE requests SET status='sent', conversation_id=$2, sent_at=now(), payload_json = payload_json || $3::jsonb WHERE id=$1 AND status='pending'`,
          [row.id, ack.conversationId, JSON.stringify(patch)]);
        status = 'sent';
      } catch (e) {
        const httpStatus = e instanceof DarajaAPIError ? (e as { httpStatus?: unknown }).httpStatus : undefined;
        const maybeQueued = e instanceof DarajaConnectionError
          || (e instanceof DarajaAPIError && typeof httpStatus === 'number' && httpStatus >= 500)
          || (e instanceof DarajaAPIError && e.message.includes(DUP_ID));
        if (maybeQueued) {
          // It may already be on its way; only the sweep can say, so the row goes unknown rather
          // than claiming the reversal did not happen.
          await deps.db.query(`UPDATE requests SET status='unknown', sent_at=now(), meaning=$2 WHERE id=$1 AND status='pending'`, [row.id, UNCONFIRMED]);
          status = 'unknown';
        } else if (e instanceof DarajaAuthError) {
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_code=NULL, result_desc=$2, meaning=$3, retriable=false WHERE id=$1 AND status='pending'`,
            [row.id, e.message, AUTH_FAILED_MEANING]);
          status = 'failed';
        } else if (e instanceof DarajaAPIError) {
          const { code, desc } = syncRejection(e);
          // Rule 3, the synchronous half: Safaricom sometimes says up front that the customer has
          // spent the money. The SDK's classifier is the one that decides, and when it fires the
          // operator is told that, not a generic "Safaricom refused".
          const spent = isSettledByRecipientSpend(desc);
          const ex = code !== null ? explain(kind.scope, code, desc) : null;
          // Brief 2, item 7: a credential refusal is Safaricom turning the reversal down outright, so
          // with another verified operator attached the row is never failed here — it goes out again
          // with that operator, which publishes its own events and answers with the fresh row. The
          // refusal is counted either way.
          if (code !== null && await recordOperatorRefusal(deps.db, deps.events, operatorId, code, desc)
              && deps.failover && await deps.failover(row.id, operatorId)) {
            const again = await getRequest(deps.db, row.id, deps.config.egressIps);
            if (again) return again;
          }
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_code=$2, result_desc=$3, meaning=$4, retriable=$5 WHERE id=$1 AND status='pending'`,
            [row.id, code, desc, spent ? SPENT_MEANING : (ex?.meaning ?? desc), spent ? false : (ex?.retriable ?? false)]);
          status = 'failed';
        } else {
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_desc=$2, meaning=$3 WHERE id=$1 AND status='pending'`,
            [row.id, 'Studio could not ask Safaricom to reverse this.', 'Something went wrong on our side before Safaricom was reached.']);
          console.error('reversal failed before Safaricom', row.id, e instanceof Error ? e.name : 'error');
          status = 'failed';
        }
      }
      await deps.events.publish('request.updated', { id: row.id, status });
      const v = await getRequest(deps.db, row.id, deps.config.egressIps);
      if (!v) throw new HttpError(500, 'not_recorded', 'Studio could not read back the reversal it recorded.');
      return v;
    },
  };
}

const receiptSchema = z.string().trim().toUpperCase().regex(RECEIPT_RE, 'An M-Pesa receipt is 10 letters and numbers, like RI6BZTPXNM.');
const reversalSchema = z.object({ receipt: receiptSchema, remarks: z.string().trim().max(100).optional() });
const receiptParamSchema = z.object({ receipt: receiptSchema });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => (i.path.join('.') + ': ' + i.message)).join('; '));
  return r.data;
}

export function reversalRoutes(deps: AppDeps): Router {
  const service = createReversalService({ ...deps, failover: (requestId, failedOperatorId) => deps.moneyOut.failover(requestId, failedOperatorId) });
  const r = Router();
  // Step one: a reversal is a module of its own, refused before the receipt is even read.
  const reversal = requireModule(deps.modules, 'reversals');
  // The pre-check, so the operator sees the payment and the amount before a password is asked and
  // before Safaricom is called. It refuses a receipt that never settled, in the same words the
  // action itself would use.
  r.get('/reversal/:receipt', requireAuth(deps.db), requireCsrf, reversal, requirePermission(deps.db, 'reverse.request'), async (req, res, next) => {
    try {
      const { receipt } = parse(receiptParamSchema, { receipt: req.params.receipt });
      const found = await service.find(receipt);
      if (!found) throw new HttpError(409, 'not_settled', NOT_SETTLED);
      res.json(found);
    } catch (e) { next(e); }
  });
  r.post('/reversal', requireAuth(deps.db), requireCsrf, reversal, requirePermission(deps.db, 'reverse.request'), requireMoneyReady(deps), requireStepUp(deps.db), async (req, res, next) => {
    try {
      const b = parse(reversalSchema, req.body);
      // Phase D-6: a reversal is irreversible, so somebody who may ask but not approve only asks.
      // The owner, or anybody given send.approve, still reverses in one press.
      const person = req.person!;
      const mayApprove = person.is_owner || (await personPermissions(deps.db, person.id)).includes('send.approve');
      res.status(201).json(await service.request(b, { personId: person.id, ip: clientIp(req) }, { hold: !mayApprove }));
    } catch (e) { next(e); }
  });
  return r;
}
