import { withOrg, type Db } from '../db/pool.js';
import type { EventHub, StudioEvent } from '../events/hub.js';
import { getRequest } from '../money_out/reads.js';
import { LEDGER_TYPES } from '../money_out/registry.js';
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
      await deps.webhooks.enqueue('request.' + r.status, {
        event: 'request.' + r.status,
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
      }, r.id, r.apiKeyId);
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
