import type { Db } from '../db/pool.js';
import { HttpError } from '../util/errors.js';

/**
 * The one place a client-named account is checked. Money out, Ask to pay, QR and invoices each take
 * an optional accountId; this decides whether it is real, live, and in the business the caller named,
 * and returns the full number Studio fills in. A retired account is refused: it is out of use.
 */
export interface ResolvedAccount {
  id: string; businessId: string; parentId: string | null; fullNumber: string; name: string;
  /** Round 3, phase A: the person behind the account — the customer above it when this is one of
   * their accounts, so "Room 4" never becomes somebody's name on a payment. */
  holderName: string;
  phone: string | null;
}

export async function resolveAccount(db: Db, accountId: string, businessId?: string | null): Promise<ResolvedAccount> {
  const [row] = await db.query<{ id: string; business_id: string; parent_id: string | null; full_number: string; name: string; holder_name: string; phone: string | null }>(
    `SELECT a.id, a.business_id, a.parent_id, a.full_number, a.name, COALESCE(p.name, a.name) AS holder_name, a.phone
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.id=$1 AND ($2::uuid IS NULL OR a.business_id = $2::uuid)`,
    [accountId, businessId ?? null]);
  if (!row) {
    throw new HttpError(400, 'unknown_account', businessId
      ? 'That account is not in this business. Pick one from the list.'
      : 'That account does not exist. Pick one from the list.');
  }
  return { id: row.id, businessId: row.business_id, parentId: row.parent_id, fullNumber: row.full_number, name: row.name, holderName: row.holder_name, phone: row.phone };
}

/** The business id the caller named, when it sent one; the account carries its own otherwise. */
export async function requireBusiness(db: Db, businessId: string): Promise<{ id: string; active: boolean }> {
  const [row] = await db.query<{ id: string; active: boolean }>(`SELECT id, active FROM businesses WHERE id=$1`, [businessId]);
  if (!row) throw new HttpError(400, 'unknown_business', 'That business does not exist. Pick one from the list.');
  if (!row.active) throw new HttpError(409, 'business_inactive', 'That business is switched off. Switch it on first.');
  return row;
}
