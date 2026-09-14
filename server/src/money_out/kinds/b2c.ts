import { parseB2cResult, type B2cSendInput } from '@kepas/daraja-js';
import type { RequestKind } from '../registry.js';
import { toCents } from '../amounts.js';

/**
 * Money out to a customer's phone. Moved here unchanged by B0: every line below behaved exactly
 * this way when it lived in registry.ts, and `money-out.test.ts` proving so is the point of the
 * move. The new fields (`recipient`, `dupKey`, `versionFallback`) describe what was already true
 * of this kind rather than changing it.
 */
export const b2c: RequestKind = {
  type: 'b2c',
  permission: 'send.phone',
  scope: 'b2c',
  callbackPath: 'b2c',
  debits: 'utility',
  wholeShillings: true,
  // What the plan sells.
  countsAsSend: true,
  recipient: 'phone',
  // The B2C API is the only one with two live versions to negotiate between. Keeping the flag on
  // the kind is what stops the v3-to-v1 gateway fallback leaking into kinds that have no such
  // choice: the SDK's pochi, b2b and reversal calls take no version option at all.
  versionFallback: true,
  dupKey: (row) => `${row.recipient_value ?? ''}|${row.amount_cents ?? ''}|b2c`,
  async send(client, row, urls, opts) {
    const p = row.payload_json as { occasion?: string };
    // v1 (Safaricom mints its own OriginatorConversationID) when the resolved version is 'v1';
    // v3 (ours is used as the idempotency key) otherwise — matches B2cSendInput's own doc comment.
    const useV1 = opts?.b2cVersion === 'v1';
    const input: B2cSendInput = {
      phone: row.recipient_value ?? '',
      amount: Number(row.amount_cents) / 100,
      commandId: (row.subtype ?? 'BusinessPayment') as 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment',
      remarks: row.remarks ?? undefined,
      occasion: p.occasion,
      ...(useV1 ? {} : { originatorConversationId: row.originator_conversation_id }),
      resultUrl: urls.b2c,
      queueTimeoutUrl: urls.b2cTimeout,
    };
    const ack = await client.b2c.send(input);
    return { conversationId: ack.conversationId, originatorConversationId: ack.originatorConversationId, responseCode: ack.responseCode, responseDescription: ack.responseDescription };
  },
  parseResult(body) {
    const r = parseB2cResult(body);
    return {
      originatorConversationId: r.originatorConversationId, conversationId: r.conversationId, resultCode: r.resultCode, resultDesc: r.resultDesc, success: r.success,
      receipt: r.mpesaReceipt ?? (r.transactionId || undefined), recipientName: r.recipientName, completedAt: r.completedAt,
      utilityCents: toCents(r.utilityAccountFunds), workingCents: toCents(r.workingAccountFunds),
    };
  },
};
