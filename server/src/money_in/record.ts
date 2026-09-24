import type { C2bPayment } from '@kepas/daraja-js';
import type { Db } from '../db/pool.js';
import type { Cache } from '../db/cache.js';
import type { EventHub } from '../events/hub.js';
import { fromClient, matchAccount } from '../businesses/match.js';
import { createFeesService } from '../fees/service.js';
import { joinPersonName, personName } from '../util/names.js';
import { linkByReceipt, linkInferred, receiptLock } from './link.js';

/** Daraja's `TransTime` is `YYYYMMDDHHmmss` in East Africa Time. */
export function transTimeToDate(t: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(t ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Where the validation callback leaves the name it saw, for the confirmation that follows it. */
export const validationNameKey = (receipt: string): string => `c2b:name:${receipt}`;

/**
 * One row per receipt, whichever way it arrived. Safaricom never retries a confirmation and the
 * pull check may find the same payment later, so the receipt is the identity: an advisory lock
 * keyed on it serialises a callback racing the check, and the second writer sees the first row.
 */
/**
 * Round 5: `source` is how the payment reached Studio — Safaricom's own confirmation (`callback`),
 * the pull (`poll`), or another system posting the confirmation through (`feed`). `silent` is for
 * the inbox's own test, which records a payment to prove the path and then removes it: nothing is
 * announced, so no screen, inbox line or webhook ever hears about a test.
 */
export async function recordC2b(deps: { db: Db; events: EventHub; cache?: Cache }, p: C2bPayment, source: 'callback' | 'poll' | 'feed', opts: { silent?: boolean } = {}): Promise<{ verdict: 'applied' | 'duplicate'; requestId: string }> {
  const receipt = String(p.transId).trim();
  // Phase A: every part Safaricom sent becomes the name, cleaned once by the helper. Only when the
  // confirmation itself carries no name does the one the validation callback saw for this same
  // receipt stand in — that callback arrives first, and Safaricom does not always repeat the name.
  const name = joinPersonName(p.firstName, p.middleName, p.lastName)
    ?? personName((await deps.cache?.take<{ name?: string }>(validationNameKey(receipt)))?.name);
  const amountCents = Math.round(Number(p.amount) * 100);
  // Feature 11: Safaricom's own charge for taking this payment, from the organisation's bands. Read
  // before the row is written and stored on it, so a later tariff change never rewrites history. An
  // amount with no band stores nothing, never a zero that would read as free.
  const chargeCents = await createFeesService({ db: deps.db }).chargeFor('c2b', amountCents);
  const out = await deps.db.tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [receiptLock(receipt)]);
    const existing = await c.query<{ id: string }>(`SELECT id FROM requests WHERE type IN ('c2b','bonga') AND receipt=$1 LIMIT 1`, [receipt]);
    if (existing.rows[0]) return { verdict: 'duplicate' as const, requestId: existing.rows[0].id };
    // Brief 2, item 1: the account number names the business (first three digits) and the account
    // Studio minted under it. The label is read here, inside the same transaction and receipt lock as
    // the row itself, so a row and its label can never disagree. It changes no amount, status or
    // receipt; a number two readings could mean, or none, stays unlabelled for a human to sort.
    const match = await matchAccount(fromClient(c), String(p.billRefNumber ?? '') || null);
    // The business is stored whenever the digits own one — including the no_account and ambiguous
    // cases, where the business is not in doubt and only the account is. The account is stored only
    // when exactly one reading of the digits names it.
    const businessId = match.kind === 'none' ? null : match.businessId;
    const accountId = match.kind === 'matched' ? match.accountId : null;
    // Lipa na Bonga (M10) settles here: a points redemption waiting under this account number is
    // this payment, so its own row is completed rather than a second one written.
    const bonga = await c.query<{ id: string }>(
      `UPDATE requests SET status='completed', result_at=now(), result_source=$3, result_code='0', result_desc='Completed', receipt=$2, recipient_name=COALESCE($4, recipient_name), raw_result_json=$5::jsonb,
         business_id=COALESCE($6, business_id), account_id=COALESCE($7, account_id), charge_cents=COALESCE(charge_cents, $8)
       WHERE id = (SELECT id FROM requests WHERE type='bonga' AND status='sent' AND account_reference=$1 ORDER BY created_at ASC LIMIT 1) RETURNING id`,
      [String(p.billRefNumber ?? ''), receipt, source, name, JSON.stringify(p), businessId, accountId, chargeCents]);
    if (bonga.rows[0]) return { verdict: 'applied' as const, requestId: bonga.rows[0].id };
    const ins = await c.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name,
         account_reference, payload_json, sent_at, result_at, result_source, result_code, result_desc, receipt, business_id, account_id, charge_cents)
       VALUES ('c2b', $1, $2, 'completed', $3, 'KES', 'phone', $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, now()), now(), $9, '0', 'Completed', $10, $11, $12, $13) RETURNING id`,
      [String(p.transactionType ?? '') || null, `c2b:${receipt}`, amountCents, String(p.msisdn ?? '') || null, name,
        String(p.billRefNumber ?? '') || null,
        // Phase A: the name fields are kept exactly as Safaricom sent them. The row's own
        // recipient_name is the cleaned reading; this is the raw one, so a name missed here (a
        // placeholder, a value this build did not understand) can still be read back later.
        JSON.stringify({ shortCode: p.shortCode, transTime: p.transTime, invoiceNumber: p.invoiceNumber, thirdPartyTransId: p.thirdPartyTransId, orgAccountBalance: p.orgAccountBalance ?? null, foundByCheck: source === 'poll', firstName: p.firstName, middleName: p.middleName, lastName: p.lastName }),
        transTimeToDate(p.transTime), source, receipt, businessId, accountId, chargeCents],
    );
    // The prompt that asked for this money, if Studio sent one and it has already been answered, is
    // joined to this row here, under the same receipt lock: the confirmation is the row that counts,
    // and it takes the business, account, key and caller's reference the prompt carried.
    // Or, when that prompt's own answer never came, the one prompt that asked for this account
    // reference and amount in the last ten minutes.
    if (!(await linkByReceipt(c, receipt))) await linkInferred(c, ins.rows[0].id);
    return { verdict: 'applied' as const, requestId: ins.rows[0].id };
  });
  if (out.verdict === 'applied' && !opts.silent) await deps.events.publish('request.updated', { id: out.requestId, status: 'completed' });
  return out;
}
