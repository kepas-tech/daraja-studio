import { withOrg, type Db } from '../db/pool.js';
import type { EventHub, StudioEvent } from '../events/hub.js';
import { getRequest } from '../money_out/reads.js';
import { LEDGER_TYPES, MONEY_IN_TYPES } from '../money_out/registry.js';
import type { WebhooksService } from './service.js';

/**
 * Round 3, phase E: what turns a Studio event into a webhook delivery.
 *
 * One rule keeps this honest: a delivery carries the same facts the payment's own page shows, under
 * the name the receiver integrates against — `request.completed`, `request.failed`, `request.unknown`
 * and the rest. Nothing here decides anything about money; it only says what happened.
 */
const REQUEST_EVENTS = new Set(['request.updated']);

export interface WebhookWriter { start(): void; stop(): void; handle(e: StudioEvent): Promise<void> }

export function createWebhookWriter(deps: { db: Db; events: EventHub; webhooks: WebhooksService; egressIps?: string[] }): WebhookWriter {
  let unsubscribe: (() => void) | null = null;

  async function handle(e: StudioEvent): Promise<void> {
    if (!REQUEST_EVENTS.has(e.type)) return;
    const org = e.orgId ?? deps.db.getFallbackOrg();
    if (!org) return;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const id = typeof payload.id === 'string' ? payload.id : null;
    if (!id) return;
    await withOrg(org, async () => {
      const r = await getRequest(deps.db, id, deps.egressIps ?? []);
      if (!r || !LEDGER_TYPES.includes(r.type)) return;
      // A confirmation that answers a prompt a key asked for carries that key, but the key has already
      // been told by the prompt's own notice. A second one, for a different row id, could credit twice.
      if (r.promptId && r.apiKeyId) return;
      // Money that arrived on its own (no prompt of ours behind it) and was filed under a business
      // goes to the app that owns that business: the live key for the business that has its own
      // address. Its event is `payment.received`, the notice that tells an app which of its users paid.
      let keyId = r.apiKeyId;
      let event = 'request.' + r.status;
      if (!keyId && !r.promptId && r.businessId && r.direction === 'in' && r.status === 'completed' && MONEY_IN_TYPES.includes(r.type)) {
        const [owner] = await deps.db.query<{ id: string }>(
          `SELECT k.id FROM api_keys k JOIN webhooks w ON w.api_key_id = k.id
            WHERE k.business_id = $1 AND k.revoked_at IS NULL ORDER BY k.created_at ASC LIMIT 1`, [r.businessId]);
        if (owner) { keyId = owner.id; event = 'payment.received'; }
      }
      await deps.webhooks.enqueue(event, {
        event,
        id: r.id,
        type: r.type,
        subtype: r.subtype,
        status: r.status,
        direction: r.direction,
        amountCents: r.amountCents,
        currency: r.currency,
        receipt: r.receipt,
        accountReference: r.accountReference,
        // The caller's own reference, handed back untouched, so a system recognises its own payment
        // without anything of its own living in the account reference.
        callerRef: r.callerRef,
        // Whose money it is (migration 050): the business, and the account with the app's own
        // reference for the user, so an app credits the right user from the notice alone.
        business: r.businessId ? { id: r.businessId, code: r.businessCode ?? null, name: r.businessName ?? null } : null,
        account: r.accountId ? { id: r.accountId, number: r.accountNumber ?? null, name: r.accountName ?? null, externalRef: r.accountExternalRef ?? null } : null,
        // Migration 049: the prompt and the confirmation of one payment name each other.
        promptId: r.promptId, confirmationId: r.confirmationId,
        // Safaricom's own name for an STK request, which is what a caller reconciles against.
        checkoutRequestId: r.checkoutRequestId,
        party: r.party,
        remarks: r.remarks,
        createdAt: r.createdAt,
        sentAt: r.sentAt,
        resultAt: r.resultAt,
        safaricomSaid: r.safaricomSaid,
        // Whose notice this is: the key that asked for the payment, when one did.
      }, r.id, keyId);
    });
  }

  return {
    handle,
    start() {
      if (unsubscribe) return;
      unsubscribe = deps.events.subscribe((e) => {
        void handle(e).catch((err) => console.error('webhook writer failed', err instanceof Error ? err.message : err));
      });
    },
    stop() { unsubscribe?.(); unsubscribe = null; },
  };
}
