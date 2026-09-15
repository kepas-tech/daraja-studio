import { billManagerAck, parseBillManagerPayment } from '@kepas/daraja-js';
import type { CallbackHandler } from './router.js';
import type { InvoicesService } from '../invoices/service.js';

/**
 * Bill Manager's payment push. It retries up to five times and expects `rescode 200` back, not
 * the generic ResultCode ack, so the handler names its own acknowledgement body.
 */
export function billManagerHandler(invoices: Pick<InvoicesService, 'applyPush'>): CallbackHandler {
  return async ({ body }) => {
    let p;
    try { p = parseBillManagerPayment(body); } catch { return { verdict: 'unmatched', ack: billManagerAck() }; }
    const out = await invoices.applyPush(p);
    return { verdict: out.verdict === 'unmatched' ? 'applied_direct' : out.verdict, requestId: out.requestId, ack: billManagerAck() };
  };
}
