import type { Db } from '../db/pool.js';
import { HttpError } from '../util/errors.js';

/**
 * The one place a client-named account is checked. Money out, Ask to pay, QR and invoices each take
 * an optional accountId; this decides whether it is real, live, and in the business the caller named,
 * and returns the full number Studio fills in. A retired account is refused: it is out of use.
 */
export interface ResolvedAccount {
  id: string; businessId: string; parentId: string | null; fullNumber: string; name: string; phone: string | null;
}

export async function resolveAccount(db: Db, accountId: string, businessId?: string | null): Promise<ResolvedAccount> {
  const [row] = await db.query<{ id: string; business_id: string; parent_id: string | null; full_number: string; name: string; phone: string | null }>(
    `SELECT id, business_id, parent_id, full_number, name, phone FROM accounts
      WHERE id=$1 AND retired_at IS NULL AND ($2::uuid IS NULL OR business_id = $2::uuid)`,
    [accountId, businessId ?? null]);
  if (!row) {
    throw new HttpError(400, 'unknown_account', businessId
      ? 'That account is not in this business. Pick one from the list.'
      : 'That account does not exist. Pick one from the list.');
  }
  return { id: row.id, businessId: row.business_id, parentId: row.parent_id, fullNumber: row.full_number, name: row.name, phone: row.phone };
}

/** The business id the caller named, when it sent one; the account carries its own otherwise. */
export async function requireBusiness(db: Db, businessId: string): Promise<{ id: string; active: boolean }> {
  const [row] = await db.query<{ id: string; active: boolean }>(`SELECT id, active FROM businesses WHERE id=$1`, [businessId]);
  if (!row) throw new HttpError(400, 'unknown_business', 'That business does not exist. Pick one from the list.');
  if (!row.active) throw new HttpError(409, 'business_inactive', 'That business is switched off. Switch it on first.');
  return row;
}
