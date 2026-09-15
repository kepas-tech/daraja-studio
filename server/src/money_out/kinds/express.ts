import { parseExpressCallback } from '@kepas/daraja-js';
import type { RequestKind } from '../registry.js';

/**
 * B2B Express Checkout (M9): this studio, the vendor, prompts another business's till by USSD;
 * they approve on their phone and their money arrives in this paybill. Money IN, in
 * `COLLECT_KINDS`. We name the request (`RequestRefID`) and Safaricom echoes it as `requestId`.
 */
export const express: RequestKind = {
  type: 'express',
  permission: 'express.checkout',
  scope: 'b2bexpress',
  callbackPath: 'express',
  debits: 'none',
  wholeShillings: true,
  countsAsSend: false,
  recipient: 'shortcode',
  dupKey: (row) => `${row.recipient_value ?? ''}|${row.amount_cents ?? ''}|express`,
  async send(client, row, urls) {
    const p = row.payload_json as { paymentRef: string; partnerName: string };
    const ack = await client.express.checkout({
      primaryShortCode: row.recipient_value ?? '', receiverShortCode: client.config.shortcode, amount: Number(row.amount_cents) / 100,
      paymentRef: p.paymentRef, callbackUrl: urls.express, partnerName: p.partnerName, requestRefId: row.originator_conversation_id,
    });
    return { originatorConversationId: ack.requestRefId, conversationId: ack.requestRefId, responseCode: '0', responseDescription: ack.status };
  },
  parseResult(body) {
    const r = parseExpressCallback(body);
    return {
      originatorConversationId: r.requestId, conversationId: r.conversationId ?? '', resultCode: Number(r.resultCode), resultDesc: r.resultDesc, success: r.success,
      receipt: r.transactionId, utilityCents: null, workingCents: null,
    };
  },
};
