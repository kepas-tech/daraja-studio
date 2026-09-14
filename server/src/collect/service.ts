import { randomUUID } from 'node:crypto';
import { DarajaAPIError, DarajaAuthError, DarajaConnectionError, normalizePhone } from '@kepas/daraja-js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import type { Settings } from '../settings/store.js';
import type { DarajaFactory } from '../sdk/client.js';
import type { EventHub } from '../events/hub.js';
import type { OrgService } from '../orgs/service.js';
import { currentCallbackSecret } from '../orgs/secret.js';
import { callbackUrls } from '../sdk/callbackUrls.js';
import { explain } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { COLLECT_KINDS, type RequestRow } from '../money_out/registry.js';
import { AUTH_FAILED_MEANING, UNCONFIRMED, syncRejection } from '../money_out/service.js';
import { getRequest, type RequestView } from '../money_out/reads.js';

export interface CollectInput {
  phone: string;
  amountCents: number;
  accountReference: string;
  description?: string;
  confirmDuplicate?: boolean;
}
export interface Actor { personId: string; ip: string }
export interface CollectService {
  askToPay(input: CollectInput, actor: Actor): Promise<RequestView>;
}

const DUP_WINDOW = "interval '5 minutes'";

export const STK_OFF = 'Add the STK passkey in Settings before asking a customer to pay.';

/**
 * Safaricom accepted the request but named it with nothing. Its callback is keyed on the checkout
 * reference and carries no other identifier we hold, so a blank one can never be matched to this
 * row. The row is therefore held as unknown rather than called sent: the customer may well have
 * been prompted and may well have paid, and asking again would charge them twice. This is the same
 * rule billing learned in production (`billing-payment-identity`), applied to a tenant's own
 * request.
 */
export const NO_CHECKOUT_ID = 'Safaricom accepted this without a reference, so Studio cannot match its answer.';
export const NO_CHECKOUT_ID_WHAT_TO_DO = 'Ask the customer whether the prompt reached them. Do not ask again until you know, or they may pay twice.';

/**
 * Asking a customer to pay. Money IN: it credits this organisation's shortcode and debits neither
 * of its accounts, so three things the send path does are deliberately absent here.
 *
 * 1. No send cap. `STUDIO_MAX_SEND_CENTS` guards money leaving; nothing leaves.
 * 2. No plan allowance check. `assertCanSend` counts a tenant's monthly *sends*; a payment request
 *    is not one, and counting it would charge a business for taking money.
 * 3. No API operator. STK Push authenticates with the app's own OAuth pair and the shortcode's
 *    passkey, not with an initiator credential, so an organisation with a passkey and no operator
 *    can still collect. What it does need is the passkey, checked below.
 *
 * What is kept from the send path, unchanged, is everything that protects against paying twice:
 * the row exists before Safaricom hears of it, the duplicate guard holds an advisory lock keyed on
 * the same identity it compares, and an outcome we cannot confirm is recorded as unknown rather
 * than retried.
 */
/**
 * Record that this environment's passkey works. Idempotent: the first proof is the one kept, so the
 * date means "since when has this been known good", not "when was the last push".
 */
async function markPasskeyProven(settings: Settings): Promise<void> {
  const env = ((await settings.get('daraja.environment')) as 'sandbox' | 'production') || 'sandbox';
  if (await settings.get(`env.${env}.passkeyProvenAt`)) return;
  await settings.set(`env.${env}.passkeyProvenAt`, new Date().toISOString());
}

export function createCollectService(deps: { db: Db; settings: Settings; daraja: DarajaFactory; events: EventHub; config: Config; orgs: OrgService }): CollectService {
  async function view(id: string): Promise<RequestView> {
    const v = await getRequest(deps.db, id, deps.config.egressIps);
    if (!v) throw new HttpError(404, 'not_found', 'That request does not exist.');
    return v;
  }

  return {
    async askToPay(input, actor) {
      const kind = COLLECT_KINDS.stk!;
      let phone: string;
      try { phone = normalizePhone(input.phone); } catch { throw new HttpError(400, 'bad_phone', 'Enter a Kenyan mobile number such as 0712 345 678.'); }
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(400, 'bad_amount', 'Enter an amount in shillings.');
      if (kind.wholeShillings && input.amountCents % 100 !== 0) throw new HttpError(400, 'whole_shillings', 'Safaricom prompts for whole shillings. Remove the cents.');
      const reference = input.accountReference.trim();
      if (!reference) throw new HttpError(400, 'bad_reference', 'Enter what this payment is for, such as an invoice number.');
      const description = input.description?.trim() || 'Payment';

      if (!(await deps.daraja.stkEnabled())) throw new HttpError(409, 'stk_off', STK_OFF);

      const publicUrl = await deps.settings.get('public.url');
      if (!publicUrl) throw new HttpError(409, 'public_url_unverified', 'Test your public address in Settings first.');
      const cb = callbackUrls(publicUrl, await currentCallbackSecret(deps.orgs));

      // Tier A: no initiator operator is involved in an STK push, so `get()` rather than
      // `getForOperator()` — the latter would refuse an organisation that can legitimately collect.
      const client = await deps.daraja.get();

      const row = await deps.db.tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [kind.dupKey({ type: kind.type, recipient_value: phone, amount_cents: String(input.amountCents), payload_json: {} })]);
        if (!input.confirmDuplicate) {
          const dup = await c.query<{ id: string; created_at: Date }>(
            `SELECT id, created_at FROM requests WHERE type=$1 AND recipient_value IS NOT DISTINCT FROM $2 AND amount_cents=$3
               AND created_at > now() - ${DUP_WINDOW} AND status NOT IN ('failed','cancelled','rejected') ORDER BY created_at DESC LIMIT 1`,
            [kind.type, phone, input.amountCents]);
          if (dup.rows[0]) throw new HttpError(409, 'duplicate_recent', 'You asked for this already. Ask again?', { requestId: dup.rows[0].id, at: dup.rows[0].created_at.toISOString() });
        }
        const { rows } = await c.query<RequestRow>(
          `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, remarks, payload_json, created_by)
           VALUES ($1,NULL,$2,'pending',$3,'KES','phone',$4,$5,$6::jsonb,$7) RETURNING *`,
          [kind.type, randomUUID(), input.amountCents, phone, reference, JSON.stringify({ accountReference: reference, description }), actor.personId]);
        const r = rows[0]!;
        await c.query(
          `INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
          [actor.personId, 'request.created', r.id, null, JSON.stringify({ type: kind.type, amountCents: input.amountCents }), actor.ip]);
        return r;
      });

      let status: string;
      try {
        const ack = await kind.send(client, row, cb);
        if (ack.responseCode !== '0') throw new DarajaAPIError(ack.responseDescription, { resultCode: Number(ack.responseCode), resultDesc: ack.responseDescription, scope: kind.scope });
        // `kind.send` maps Safaricom's CheckoutRequestID onto originatorConversationId — it is the
        // only identifier the callback carries back, so it is what `applyResult` must be able to
        // resolve this row by.
        const checkoutId = ack.originatorConversationId;
        if (!checkoutId) {
          await deps.db.query(
            `UPDATE requests SET status='unknown', sent_at=now(), conversation_id=$2, meaning=$3 WHERE id=$1 AND status='pending'`,
            [row.id, ack.conversationId || null, NO_CHECKOUT_ID]);
          status = 'unknown';
        } else {
          await deps.db.query(
            `UPDATE requests SET status='sent', conversation_id=$2, sent_at=now(), payload_json = payload_json || $3::jsonb WHERE id=$1 AND status='pending'`,
            [row.id, ack.conversationId, JSON.stringify({ ackOriginatorConversationId: checkoutId })]);
          status = 'sent';
          // Safaricom accepted a push on this shortcode, which is the only proof a passkey can ever
          // have: no read-only Daraja call uses it. Recorded once, and never on a refusal — a wrong
          // passkey is rejected at the acknowledgement, before any phone rings.
          await markPasskeyProven(deps.settings);
        }
      } catch (e) {
        const httpStatus = e instanceof DarajaAPIError ? (e as { httpStatus?: unknown }).httpStatus : undefined;
        // The prompt may already be on the customer's phone: a dropped connection, or a 5xx that
        // could have followed a request Safaricom already queued. Asking again could charge them
        // twice, so the row is held, never retried.
        const maybePrompted = e instanceof DarajaConnectionError
          || (e instanceof DarajaAPIError && typeof httpStatus === 'number' && httpStatus >= 500);
        if (maybePrompted) {
          await deps.db.query(`UPDATE requests SET status='unknown', sent_at=now(), meaning=$2 WHERE id=$1 AND status='pending'`, [row.id, UNCONFIRMED]);
          status = 'unknown';
        } else if (e instanceof DarajaAuthError) {
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_code=NULL, result_desc=$2, meaning=$3, retriable=false WHERE id=$1 AND status='pending'`,
            [row.id, e.message, AUTH_FAILED_MEANING]);
          status = 'failed';
        } else if (e instanceof DarajaAPIError) {
          // A synchronous rejection is Safaricom refusing before anything was queued: no prompt was
          // shown, so the operator may safely fix what it names and ask again.
          const { code, desc } = syncRejection(e);
          const ex = code !== null ? explain(kind.scope, code, desc, { egressIps: deps.config.egressIps }) : null;
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_code=$2, result_desc=$3, meaning=$4, retriable=$5 WHERE id=$1 AND status='pending'`,
            [row.id, code, desc, ex?.meaning ?? desc, ex?.retriable ?? false]);
          status = 'failed';
        } else {
          await deps.db.query(`UPDATE requests SET status='failed', result_at=now(), result_desc=$2, meaning=$3 WHERE id=$1 AND status='pending'`,
            [row.id, 'Studio could not ask for this payment.', 'Something went wrong on our side before Safaricom was reached.']);
          console.error('collect failed before Safaricom', row.id, e instanceof Error ? e.name : 'error');
          status = 'failed';
        }
      }
      await deps.events.publish('request.updated', { id: row.id, status });
      return view(row.id);
    },
  };
}
