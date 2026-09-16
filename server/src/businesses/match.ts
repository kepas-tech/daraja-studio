/**
 * Which business — and which customer — a payer's account number names. Feature 2, plan section E:
 * the number is <business code><customer number>, digits only, and the code is always exactly three
 * characters. Nothing here reads or writes money: it labels a row.
 *
 * Pure and database-free on purpose: parseAccount is the whole rule, and every caller feeds it the
 * organisation's businesses. matchAccount adds the one customer lookup.
 */

export interface KnownBusiness { id: string; code: string }

export interface ParsedAccount {
  /** The business this reference belongs to, or null when no business owns it. */
  businessId: string | null;
  /** Customer numbers the reference could mean, best first. Empty means the business, no customer. */
  candidates: number[];
  /** The payer typed something that names no known business. Only possible with two or more. */
  unmatched: boolean;
}

const DIGITS = /^[0-9]+$/;
const NONE: ParsedAccount = { businessId: null, candidates: [], unmatched: false };

/**
 * The rule, in one place.
 *
 * - No businesses: nothing to decide; the row carries no label (the feature is not in use).
 * - One business: routing is off and that business owns the row whatever was typed. The reference is
 *   still read as a customer number, whole (123) or with the business's own code in front of it
 *   (001123 for business 001). The account-number form is tried first because that is what the
 *   customer was told to type. A reference that is exactly the code means the business and no
 *   customer.
 * - Two or more: the first three characters must be digits naming a known business. What follows is
 *   read as one integer, so 123, 0123 and 00123 all mean customer 123. Nothing after a known code is
 *   the business with no customer, which is not unmatched. Anything else is unmatched: the money
 *   arrived, and a human decides what it was for.
 *
 * An inactive business still owns its rows: the money arrived whatever the owner did to the label.
 */
export function parseAccount(reference: string | null | undefined, businesses: readonly KnownBusiness[]): ParsedAccount {
  if (businesses.length === 0) return NONE;
  const ref = String(reference ?? '').trim();
  if (businesses.length === 1) {
    const code = businesses[0].code;
    if (!DIGITS.test(ref)) return { businessId: businesses[0].id, candidates: [], unmatched: false };
    if (ref === code) return { businessId: businesses[0].id, candidates: [], unmatched: false };
    if (ref.length > code.length && ref.startsWith(code)) {
      const rest = Number(ref.slice(code.length));
      const whole = Number(ref);
      return { businessId: businesses[0].id, candidates: whole === rest ? [rest] : [rest, whole], unmatched: false };
    }
    return { businessId: businesses[0].id, candidates: [Number(ref)], unmatched: false };
  }
  if (ref.length < 3 || !DIGITS.test(ref.slice(0, 3))) return { businessId: null, candidates: [], unmatched: true };
  const business = businesses.find((b) => b.code === ref.slice(0, 3));
  if (!business) return { businessId: null, candidates: [], unmatched: true };
  const rest = ref.slice(3);
  if (rest === '') return { businessId: business.id, candidates: [], unmatched: false };
  if (!DIGITS.test(rest)) return { businessId: null, candidates: [], unmatched: true };
  return { businessId: business.id, candidates: [Number(rest)], unmatched: false };
}

export type AccountMatch =
  | { kind: 'none' }
  | { kind: 'matched'; businessId: string; customerId: string | null }
  | { kind: 'unmatched' };

/** What the caller passes: a pooled client or a transaction client. The rows are read as given. */
export interface Queryable { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }

/**
 * Read this organisation's businesses, parse the reference, and resolve the customer number against
 * the live customers of that business. Runs inside whatever transaction the caller already holds, so
 * the label is written with the same receipt lock as the row itself.
 */
export async function matchAccount(c: Queryable, reference: string | null | undefined): Promise<AccountMatch> {
  const businesses = (await c.query('SELECT id, code FROM businesses ORDER BY code')).rows as KnownBusiness[];
  const parsed = parseAccount(reference, businesses);
  if (parsed.unmatched) return { kind: 'unmatched' };
  if (!parsed.businessId) return { kind: 'none' };
  for (const number of parsed.candidates) {
    const found = (await c.query('SELECT id FROM customers WHERE business_id=$1 AND number=$2 AND deleted_at IS NULL', [parsed.businessId, number])).rows as { id: string }[];
    if (found[0]) return { kind: 'matched', businessId: parsed.businessId, customerId: found[0].id };
  }
  return { kind: 'matched', businessId: parsed.businessId, customerId: null };
}
