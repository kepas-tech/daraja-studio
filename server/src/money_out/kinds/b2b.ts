import { parseB2bResult, type B2bCommandId } from '@kepas/daraja-js';
import type { RequestKind } from '../registry.js';

/**
 * Pay another business: a paybill (with the account number it asks for) or a till. The row's
 * subtype is Safaricom's command, `BusinessPayBill` or `BusinessBuyGoods`; recipient_value is the
 * shortcode being paid and payload_json.accountReference the account number quoted, if any.
 *
 * B2B draws on the Working account, not Utility: that is where payments in land, and it is what
 * `meaning.ts` already says a B2B refusal for insufficient funds means.
 *
 * A B2B result carries a transaction id, a code, a description and the receiving business's public
 * name. It carries no account balances in a form the balance table reads, so none are written here;
 * the balance refresh that follows every settled result reads them properly instead.
 */
export const b2b: RequestKind = {
  type: 'b2b',
  // The route checks pay.till for a till; this is the paybill case and the kind's default.
  permission: 'pay.paybill',
  scope: 'b2b',
  callbackPath: 'b2b',
  debits: 'working',
  wholeShillings: true,
  // Paying a supplier is a send like any other.
  countsAsSend: true,
  recipient: 'shortcode',
  // The account number is part of the identity: paying two meters on one paybill is two payments.
  dupKey: (row) => `${row.recipient_value ?? ''}|${(row.payload_json as { accountReference?: string | null }).accountReference ?? ''}|${row.amount_cents ?? ''}|b2b`,
  async send(client, row, urls) {
    const p = row.payload_json as { accountReference?: string | null };
    const ack = await client.b2b.pay({
      toShortcode: row.recipient_value ?? '',
      amount: Number(row.amount_cents) / 100,
      commandId: (row.subtype ?? 'BusinessPayBill') as B2bCommandId,
      accountReference: p.accountReference ?? undefined,
      remarks: row.remarks ?? undefined,
      resultUrl: urls.b2b,
      // Same shape as the reversal: the timeout lands on a child path so it can never be read as
      // the result itself.
      queueTimeoutUrl: urls.b2b + '/timeout',
    });
    return { conversationId: ack.conversationId, originatorConversationId: ack.originatorConversationId, responseCode: ack.responseCode, responseDescription: ack.responseDescription };
  },
  parseResult(body) {
    const r = parseB2bResult(body);
    const name = r.params.ReceiverPartyPublicName;
    return {
      originatorConversationId: r.originatorConversationId, conversationId: r.conversationId, resultCode: r.resultCode, resultDesc: r.resultDesc, success: r.success,
      receipt: r.transactionId || undefined,
      // "600000 - ACME TRADERS": personName() drops the number, as it does for a phone.
      recipientName: typeof name === 'string' ? name : undefined,
      utilityCents: null, workingCents: null,
    };
  },
};
