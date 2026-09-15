import type { C2bPayment } from '@kepas/daraja-js';
import type { Db } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';

/** Daraja's `TransTime` is `YYYYMMDDHHmmss` in East Africa Time. */
export function transTimeToDate(t: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(t ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One row per receipt, whichever way it arrived. Safaricom never retries a confirmation and the
 * pull check may find the same payment later, so the receipt is the identity: an advisory lock
 * keyed on it serialises a callback racing the check, and the second writer sees the first row.
 */
export async function recordC2b(deps: { db: Db; events: EventHub }, p: C2bPayment, source: 'callback' | 'poll'): Promise<{ verdict: 'applied' | 'duplicate'; requestId: string }> {
  const receipt = String(p.transId).trim();
  const name = [p.firstName, p.middleName, p.lastName].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ') || null;
  const out = await deps.db.tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`c2b:${receipt}`]);
    const existing = await c.query<{ id: string }>(`SELECT id FROM requests WHERE type='c2b' AND receipt=$1 LIMIT 1`, [receipt]);
    if (existing.rows[0]) return { verdict: 'duplicate' as const, requestId: existing.rows[0].id };
    const ins = await c.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name,
         account_reference, payload_json, sent_at, result_at, result_source, result_code, result_desc, receipt)
       VALUES ('c2b', $1, $2, 'completed', $3, 'KES', 'phone', $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, now()), now(), $9, '0', 'Completed', $10) RETURNING id`,
      [String(p.transactionType ?? '') || null, `c2b:${receipt}`, Math.round(Number(p.amount) * 100), String(p.msisdn ?? '') || null, name,
        String(p.billRefNumber ?? '') || null,
        JSON.stringify({ shortCode: p.shortCode, transTime: p.transTime, invoiceNumber: p.invoiceNumber, thirdPartyTransId: p.thirdPartyTransId, orgAccountBalance: p.orgAccountBalance ?? null, foundByCheck: source === 'poll' }),
        transTimeToDate(p.transTime), source, receipt],
    );
    return { verdict: 'applied' as const, requestId: ins.rows[0].id };
  });
  if (out.verdict === 'applied') await deps.events.publish('request.updated', { id: out.requestId, status: 'completed' });
  return out;
}
