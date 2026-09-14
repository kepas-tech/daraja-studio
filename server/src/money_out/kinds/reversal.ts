import { parseReversalResult } from '@kepas/daraja-js';
import type { RequestKind } from '../registry.js';
import { toCents } from '../amounts.js';

/** Safaricom reports numbers; a refusal carries none. */
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * M3: take back a payment that already settled. One call, and all of the care is in the rules the
 * service enforces before this kind is reached — see money_out/reversal.ts.
 *
 * The row's recipient_value is the M-Pesa receipt being reversed, which is what
 * recipient: 'receipt' says. That receipt is also the duplicate identity, and the amount is
 * deliberately absent from it: an irreversible reversal is identified by the payment it takes back,
 * so a second attempt on the same receipt is refused whatever amount it computes.
 */
export const reversal: RequestKind = {
  type: 'reversal',
  permission: 'reverse.request',
  scope: 'reversal',
  callbackPath: 'reversal',
  // A reversal of a payout puts the money back where it came from, the Utility account.
  debits: 'utility',
  wholeShillings: true,
  // A refund of a payment that should not have happened; it must never spend a send allowance.
  countsAsSend: false,
  recipient: 'receipt',
  dupKey: (row) => (row.recipient_value ?? '') + '|reversal',
  async send(client, row, urls) {
    const ack = await client.reversal.request({
      transactionId: row.recipient_value ?? '',
      amount: Number(row.amount_cents) / 100,
      resultUrl: urls.reversal,
      // The reversal API has one result address plus a queue-timeout address; the timeout lands on
      // a child path so it can never be mistaken for the result itself.
      queueTimeoutUrl: urls.reversal + '/timeout',
      remarks: row.remarks ?? undefined,
    });
    return {
      conversationId: ack.conversationId,
      originatorConversationId: ack.originatorConversationId,
      responseCode: ack.responseCode,
      responseDescription: ack.responseDescription,
    };
  },
  parseResult(body) {
    const r = parseReversalResult(body);
    return {
      originatorConversationId: r.originatorConversationId,
      conversationId: r.conversationId,
      resultCode: r.resultCode,
      resultDesc: r.resultDesc,
      success: r.success,
      // A reversal result echoes the receipt it took back; there is no other receipt on it.
      receipt: r.transactionId || undefined,
      // The result mirrors the B2C envelope, so the two account balances come back on success and
      // are absent on a refusal. Reading them the same way keeps one balance row per real answer.
      utilityCents: toCents(num(r.params.B2CUtilityAccountAvailableFunds)),
      workingCents: toCents(num(r.params.B2CWorkingAccountAvailableFunds)),
    };
  },
};
