import { parseStkCallback } from '@kepas/daraja-js';
import type { RequestKind } from '../registry.js';

/**
 * Ask a customer to pay: Safaricom prompts their phone, they enter their PIN, the money arrives at
 * this organisation's own shortcode. Money IN, so it is registered in `COLLECT_KINDS`, never in
 * `KINDS` — see the comments there for why counting it as a send would be wrong.
 *
 * Not the same thing as billing's payment requests. Those charge tenants on the *host's* shortcode
 * under the system context and live in `payments`. This charges a tenant's own customers on the
 * tenant's own shortcode, at the tenant's own callback address, and lives in `requests` beside
 * everything else that organisation has asked Safaricom to do.
 *
 * Identifiers: Safaricom names an STK request by `checkoutRequestId` and echoes it in the callback,
 * which is the same role `originatorConversationId` plays for a send. Mapping the two here is what
 * lets one result path, one sweep and one History serve both directions without special cases.
 */
export const stk: RequestKind = {
  type: 'stk',
  permission: 'stk.request',
  scope: 'stk',
  callbackPath: 'stk',
  // Money coming in credits the shortcode; it debits neither account.
  debits: 'none',
  wholeShillings: true,
  // Money in. It is not in KINDS at all, so it reaches no allowance; stated for the compiler and the reader.
  countsAsSend: false,
  recipient: 'phone',
  dupKey: (row) => `${row.recipient_value ?? ''}|${row.amount_cents ?? ''}|stk`,
  async send(client, row, urls) {
    const p = row.payload_json as { accountReference?: string; description?: string };
    const ack = await client.collect.stkPush({
      phone: row.recipient_value ?? '',
      amount: Number(row.amount_cents) / 100,
      accountReference: p.accountReference ?? '',
      description: p.description ?? 'Payment',
      callbackUrl: urls.stk,
    });
    return {
      // Safaricom's own name for this request, and the only identifier its callback carries back.
      originatorConversationId: ack.checkoutRequestId,
      conversationId: ack.merchantRequestId,
      responseCode: ack.responseCode,
      responseDescription: ack.responseDescription,
    };
  },
  parseResult(body) {
    const r = parseStkCallback(body);
    return {
      originatorConversationId: r.checkoutRequestId,
      conversationId: r.merchantRequestId,
      resultCode: r.resultCode,
      resultDesc: r.resultDesc,
      success: r.success,
      receipt: r.mpesaReceiptNumber,
      // Safaricom reports no balances on an STK result and no payer name, only a phone number,
      // which is never echoed back into a row. Inventing either would be recording what we were
      // not told.
      utilityCents: null,
      workingCents: null,
    };
  },
};
