import type { RequestKind } from '../registry.js';

/**
 * Lipa na Bonga (M10): the customer pays with loyalty points. `redeem` prompts their phone for a
 * PIN; the settlement then lands on the ordinary C2B confirmation with the account number this
 * row carries, and `money_in/record.ts` completes the row instead of writing a second one. So
 * this kind answers on no callback path of its own, and its result parser is never reached.
 */
export const bonga: RequestKind = {
  type: 'bonga',
  permission: 'bonga.redeem',
  scope: 'bonga',
  callbackPath: 'c2b/confirm',
  debits: 'none',
  wholeShillings: true,
  countsAsSend: false,
  recipient: 'phone',
  dupKey: (row) => `${row.recipient_value ?? ''}|${(row.payload_json as { accountReference?: string }).accountReference ?? ''}|bonga`,
  async send(client, row) {
    const p = row.payload_json as { points: number; rate: number; accountReference: string };
    const ack = await client.bonga.redeem({ msisdn: row.recipient_value ?? '', amount: Number(row.amount_cents) / 100, bongaPoints: p.points, conversionRate: p.rate, accountNumber: p.accountReference });
    return { originatorConversationId: ack.requestRefId, conversationId: ack.requestRefId, responseCode: '0', responseDescription: ack.customerMessage || ack.responseMessage };
  },
  parseResult() { throw new Error('bonga settles on the C2B confirmation, not on a callback of its own'); },
};
