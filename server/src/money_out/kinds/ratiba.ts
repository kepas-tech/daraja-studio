import { parseRatibaCallback, type RatibaCreateInput } from '@kepas/daraja-js';
import type { RequestKind } from '../registry.js';

/**
 * A standing order (M-Pesa Ratiba, M8): the customer consents on their phone once, then Safaricom
 * collects on schedule. Money IN, in `COLLECT_KINDS`. The row is the order itself; each collection
 * later arrives as an ordinary C2B confirmation. Safaricom names the request by `responseRefID`
 * in the acknowledgement and echoes it in the callback, so that is the row's identifier.
 */
export const ratiba: RequestKind = {
  type: 'ratiba',
  permission: 'standing_orders.manage',
  scope: 'ratiba',
  callbackPath: 'ratiba',
  debits: 'none',
  wholeShillings: true,
  countsAsSend: false,
  recipient: 'phone',
  dupKey: (row) => `${row.recipient_value ?? ''}|${(row.payload_json as { name?: string }).name ?? ''}|ratiba`,
  async send(client, row, urls) {
    const p = row.payload_json as { name: string; startDate: string; endDate: string; transactionType: 'paybill' | 'buygoods'; frequency: RatibaCreateInput['frequency']; accountReference: string; transactionDesc: string };
    const ack = await client.ratiba.create({
      name: p.name, startDate: p.startDate, endDate: p.endDate, transactionType: p.transactionType, amount: Number(row.amount_cents) / 100,
      phone: row.recipient_value ?? '', callbackUrl: urls.ratiba, accountReference: p.accountReference, transactionDesc: p.transactionDesc, frequency: p.frequency,
    });
    // The SDK throws on a non-200 header, so reaching here is acceptance; the row's status code is '0'.
    return { originatorConversationId: ack.responseRefId, conversationId: ack.responseRefId, responseCode: '0', responseDescription: ack.responseDescription };
  },
  parseResult(body) {
    const r = parseRatibaCallback(body);
    return {
      originatorConversationId: r.responseRefId, conversationId: r.requestRefId, resultCode: Number(r.responseCode), resultDesc: r.responseDescription, success: r.success,
      receipt: r.transactionId, utilityCents: null, workingCents: null,
    };
  },
};
