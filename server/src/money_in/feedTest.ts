import { randomBytes } from 'node:crypto';
import { parseC2bConfirmation } from '@kepas/daraja-js';
import type { Db } from '../db/pool.js';
import type { Cache } from '../db/cache.js';
import type { EventHub } from '../events/hub.js';
import { recordC2b } from './record.js';

/**
 * Round 5: the test that proves the inbox works before the first real payment.
 *
 * It runs the whole path the way a forwarder would — a body with Safaricom's own field names,
 * through the same parser and the same recording — twice, to prove the receipt rule, and then
 * removes the row it made. Nothing is announced (`silent`), so no screen, inbox line or webhook
 * ever hears about a test, and no fake money is left behind.
 */
export interface FeedTestResult {
  ok: boolean;
  receipt: string;
  first: 'applied' | 'duplicate';
  /** True when the very same body, sent twice, was recorded once. */
  idempotent: boolean;
  /** True when the payer's name landed on the row the way a confirmation's would. */
  named: boolean;
  removed: boolean;
  said: string;
}

/** `YYYYMMDDHHmmss` in East Africa Time, the way Safaricom writes `TransTime`. */
export function eatTransTime(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

/** Safaricom's own C2B confirmation body, filled with a test payment. Exported for the guide's sample. */
export function sampleBody(shortcode: string, receipt: string, now: Date = new Date()): Record<string, string> {
  return {
    TransactionType: 'Pay Bill',
    TransID: receipt,
    TransTime: eatTransTime(now),
    TransAmount: '1.00',
    BusinessShortCode: shortcode,
    BillRefNumber: 'STUDIO-TEST',
    InvoiceNumber: '',
    OrgAccountBalance: '',
    ThirdPartyTransID: '',
    MSISDN: '254700000000',
    FirstName: 'Studio',
    MiddleName: 'Test',
    LastName: 'Payment',
  };
}

export async function runFeedTest(deps: { db: Db; events: EventHub; cache?: Cache; shortcode: string }): Promise<FeedTestResult> {
  const receipt = 'TEST' + randomBytes(3).toString('hex').toUpperCase();
  const body = sampleBody(deps.shortcode, receipt);
  const p = parseC2bConfirmation(body);

  const first = await recordC2b(deps, p, 'feed', { silent: true });
  const second = await recordC2b(deps, p, 'feed', { silent: true });
  const [row] = await deps.db.query<{ recipient_name: string | null; result_source: string; amount_cents: string; receipt: string }>(
    'SELECT recipient_name, result_source, amount_cents, receipt FROM requests WHERE id = $1', [first.requestId]);

  // Remove the test payment: it was never real money, so it must not sit in anyone's books.
  await deps.db.query('DELETE FROM requests WHERE id = $1', [first.requestId]);
  const gone = (await deps.db.query('SELECT 1 FROM requests WHERE id = $1', [first.requestId])).length === 0;

  const named = !!row?.recipient_name;
  const idempotent = first.verdict === 'applied' && second.verdict === 'duplicate' && second.requestId === first.requestId;
  const ok = idempotent && named && row?.result_source === 'feed' && gone;
  return {
    ok, receipt, first: first.verdict, idempotent, named, removed: gone,
    said: ok
      ? `The path works: ${receipt} was recorded as a fed payment with the payer's name on it, the same body sent again changed nothing, and the test payment has been removed.`
      : 'The test did not come out right. Check the studio’s logs before pointing a forwarder at this address.',
  };
}
