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
        party: r.party,
        remarks: r.remarks,
        createdAt: r.createdAt,
        sentAt: r.sentAt,
        resultAt: r.resultAt,
        safaricomSaid: r.safaricomSaid,
      }, r.id);
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
