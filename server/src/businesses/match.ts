/**
 * Which business — and which account — a payer's account number names. Brief 2, item 1: three
 * levels, digits only, and the width of a number is written into the number itself, so nothing a
 * payer types can be read two ways.
 *
 * A leading 9 means "one digit longer than the base": width 3 is ddd with the first digit 0-8
 * (000-899), width 4 is 9ddd (9000-9899), width 5 is 99ddd, and so on. Reading is therefore exact —
 * count the leading 9s, take 3 + that many digits — and needs no table of widths to split a
 * reference. What still needs the database is whether the number that came out is one anybody
 * holds.
 *
 * Pure and database-free on purpose: parseAccount is the whole rule, and every caller feeds it the
 * organisation's businesses and its live accounts. matchAccount adds the two queries.
 */

export interface KnownBusiness { id: string; code: string }

/** One live account, flattened: the digits at its own level, its parent, and the number a payer types. */
export interface KnownAccount {
  id: string; businessId: string; parentId: string | null; number: string; fullNumber: string; name: string;
}

export type UnmatchedReason = 'no_business' | 'no_account' | 'no_sub' | 'too_many';

export type AccountMatch =
  | { kind: 'none' }
  | { kind: 'matched'; businessId: string; accountId: string | null }
  | {
      kind: 'unmatched'; reason: UnmatchedReason; businessId: string | null;
      /** For no_sub: the account whose number was named, so the card can say which one. */
      accountName: string | null;
    };

const DIGITS = /^[0-9]+$/;
const NONE: AccountMatch = { kind: 'none' };

/** One level's number, read off the digits themselves. `rest` is what is left for the level below. */
export interface Reading { number: string; rest: string }

/**
 * The self-describing read: count the leading 9s, and the width is 3 + that count. Null when the
 * digits are shorter than the width they announce, which is a number nobody could have been given.
 */
export function readNumber(digits: string): Reading | null {
  let nines = 0;
  while (nines < digits.length && digits[nines] === '9') nines += 1;
  const width = 3 + nines;
  if (digits.length < width) return null;
  return { number: digits.slice(0, width), rest: digits.slice(width) };
}

type Resolution =
  | { kind: 'ok'; accountId: string }
  | { kind: 'no_account' }
  | { kind: 'no_sub'; accountName: string }
  | { kind: 'too_many' };

/**
 * One business's account part: the account, then the sub-account under it when digits remain. Every
 * failure has its own name, because the card on Money in says which one happened.
 */
export function resolveTail(digits: string, accounts: readonly KnownAccount[]): Resolution {
  const account = readNumber(digits);
  if (!account) return { kind: 'no_account' };
  const parent = accounts.find((a) => a.parentId === null && a.number === account.number);
  if (!parent) return { kind: 'no_account' };
  if (account.rest === '') return { kind: 'ok', accountId: parent.id };
  const sub = readNumber(account.rest);
  if (!sub) return { kind: 'too_many' };
  const under = accounts.find((a) => a.parentId === parent.id && a.number === sub.number);
  if (!under) return { kind: 'no_sub', accountName: parent.name };
  if (sub.rest !== '') return { kind: 'too_many' };
  return { kind: 'ok', accountId: under.id };
}

const matched = (businessId: string, accountId: string | null): AccountMatch => ({ kind: 'matched', businessId, accountId });
const unmatched = (reason: UnmatchedReason, businessId: string | null, accountName: string | null): AccountMatch =>
  ({ kind: 'unmatched', reason, businessId, accountName });
const failure = (r: Resolution, businessId: string | null): AccountMatch =>
  r.kind === 'no_sub' ? unmatched('no_sub', businessId, r.accountName) : unmatched(r.kind === 'ok' ? 'no_account' : r.kind, businessId, null);

/**
 * The rule, in one place.
 *
 * - No businesses: nothing to decide; the row carries no label (the feature is not in use).
 * - One business: routing is off, so the code is not required in front. Studio prints the full
 *   number, so the code-stripped form is read first; a payer who typed only the account part still
 *   resolves, because the whole reference is read second.
 * - Two or more: the first three characters must be digits naming a known business. Nothing after a
 *   known code is the business with no account, which is not unmatched.
 * - A reference that is not digits names no business. With one business the money still belongs to
 *   it — that business owns the row, unlabelled.
 *
 * An inactive business still owns its rows: the money arrived whatever the owner did to the label.
 */
export function parseAccount(
  reference: string | null | undefined,
  businesses: readonly KnownBusiness[],
  accounts: readonly KnownAccount[],
): AccountMatch {
  if (businesses.length === 0) return NONE;
  const ref = String(reference ?? '').trim();
  if (!DIGITS.test(ref)) {
    return businesses.length === 1 ? matched(businesses[0].id, null) : unmatched('no_business', null, null);
  }
  const of = (businessId: string) => accounts.filter((a) => a.businessId === businessId);

  if (businesses.length === 1) {
    const business = businesses[0];
    const stripped = ref.length > business.code.length && ref.startsWith(business.code)
      ? ref.slice(business.code.length)
      : null;
    const tries = stripped === null ? [ref] : stripped === '' ? [] : [stripped, ref];
    let first: Resolution | null = null;
    for (const digits of tries) {
      const r = resolveTail(digits, of(business.id));
      if (r.kind === 'ok') return matched(business.id, r.accountId);
      if (!first) first = r;
    }
    if (ref === business.code) return matched(business.id, null);
    return failure(first ?? { kind: 'no_account' }, business.id);
  }

  if (ref.length < 3) return unmatched('no_business', null, null);
  const business = businesses.find((b) => b.code === ref.slice(0, 3));
  if (!business) return unmatched('no_business', null, null);
  const rest = ref.slice(3);
  if (rest === '') return matched(business.id, null);
  const r = resolveTail(rest, of(business.id));
  return r.kind === 'ok' ? matched(business.id, r.accountId) : failure(r, business.id);
}

/** Anything whose query already resolves to the rows: the pool, or a transaction using a Db shape. */
export interface Queryable { query: (text: string, values?: unknown[]) => Promise<unknown[]> }

/**
 * A raw pg client resolves to a result object instead. A callback runs inside the transaction that
 * holds the receipt lock, so the rows must be read on that same client — this adapts the shape
 * without leaving it.
 */
export function fromClient(c: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }): Queryable {
  return { query: async (text, values) => (await c.query(text, values)).rows };
}

export interface AccountIndex { businesses: KnownBusiness[]; accounts: KnownAccount[] }

/** Every business of this organisation, and every live account, in two queries. */
export async function loadIndex(c: Queryable): Promise<AccountIndex> {
  const businesses = (await c.query('SELECT id, code FROM businesses ORDER BY code')) as KnownBusiness[];
  if (businesses.length === 0) return { businesses, accounts: [] };
  const rows = (await c.query(
    'SELECT id, business_id, parent_id, number, full_number, name FROM accounts ORDER BY number',
  )) as { id: string; business_id: string; parent_id: string | null; number: string; full_number: string; name: string }[];
  return {
    businesses,
    accounts: rows.map((r) => ({ id: r.id, businessId: r.business_id, parentId: r.parent_id, number: r.number, fullNumber: r.full_number, name: r.name })),
  };
}

/**
 * Read this organisation's businesses and live accounts, parse the reference, and resolve it. Runs
 * inside whatever transaction the caller already holds, so a label is written with the same receipt
 * lock as the row itself.
 */
export async function matchAccount(c: Queryable, reference: string | null | undefined): Promise<AccountMatch> {
  const index = await loadIndex(c);
  return parseAccount(reference, index.businesses, index.accounts);
}
