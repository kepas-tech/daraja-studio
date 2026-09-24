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
const REQUEST_EVENTS = new Set(['request.updated', 'payment.assigned']);

export interface WebhookWriter { start(): void; stop(): void; handle(e: StudioEvent): Promise<void> }

type View = NonNullable<Awaited<ReturnType<typeof getRequest>>>;

export function createWebhookWriter(deps: { db: Db; events: EventHub; webhooks: WebhooksService; egressIps?: string[] }): WebhookWriter {
  let unsubscribe: (() => void) | null = null;

  /**
   * The key that speaks for the app owning a business: a live key for that business with its own
   * address, the one made for the business's app first (migration 051), then the oldest.
   */
  async function ownerOf(businessId: string | null): Promise<string | null> {
    if (!businessId) return null;
    const [owner] = await deps.db.query<{ id: string }>(
      `SELECT k.id FROM api_keys k JOIN webhooks w ON w.api_key_id = k.id LEFT JOIN apps a ON a.id = k.app_id
        WHERE k.business_id = $1 AND k.revoked_at IS NULL
        ORDER BY COALESCE(a.business_id = k.business_id, false) DESC, k.created_at ASC LIMIT 1`, [businessId]);
    return owner?.id ?? null;
  }

  /** Money that arrived on its own: no prompt of ours behind it. */
  const arrivedAlone = (r: View) => !r.promptId && r.direction === 'in' && r.status === 'completed' && MONEY_IN_TYPES.includes(r.type);

  async function payloadOf(event: string, r: View, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const [app] = r.businessId
      ? await deps.db.query<{ key: string; name: string }>(`SELECT key, name FROM apps WHERE business_id = $1`, [r.businessId])
      : [];
    return {
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
      // Migration 051: the app that owns the business, by the key its configuration file gives it.
      app: app ? { key: app.key, name: app.name } : null,
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
      ...extra,
    };
  }

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

      // A payment filed under another business (or account) after it arrived. Whoever was told about
      // it before, and whoever it belongs to now, hear `payment.updated`, carrying where it was: the
      // one that credited it takes the credit back, the new one credits it. A payment no app owns is
      // told to the organisation's own address, as its first notice was.
      if (e.type === 'payment.assigned') {
        if (!arrivedAlone(r)) return;
        const before = (payload.before ?? {}) as { businessId?: string | null; accountId?: string | null };
        const was = before.businessId ?? null;
        const [prev] = was ? await deps.db.query<{ code: string; name: string }>(`SELECT code, name FROM businesses WHERE id = $1`, [was]) : [];
        const previous = {
          business: was ? { id: was, code: prev?.code ?? null, name: prev?.name ?? null } : null,
          accountId: before.accountId ?? null,
        };
        const told = new Set([await ownerOf(was), await ownerOf(r.businessId)]);
        for (const keyId of told) await deps.webhooks.enqueue('payment.updated', await payloadOf('payment.updated', r, { previous }), r.id, keyId);
        return;
      }

      // A confirmation that answers a prompt a key asked for carries that key, but the key has already
      // been told by the prompt's own notice. A second one, for a different row id, could credit twice.
      if (r.promptId && r.apiKeyId) return;
      // Money that arrived on its own and was filed under a business goes to the app that owns that
      // business, as `payment.received`, the notice that tells an app which of its users paid.
      let keyId = r.apiKeyId;
      let event = 'request.' + r.status;
      if (!keyId && arrivedAlone(r)) {
        const owner = await ownerOf(r.businessId);
        if (owner) { keyId = owner; event = 'payment.received'; }
      }
      // Whose notice this is: the key that asked for the payment, when one did.
      await deps.webhooks.enqueue(event, await payloadOf(event, r), r.id, keyId);
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
