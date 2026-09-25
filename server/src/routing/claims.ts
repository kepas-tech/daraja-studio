import { randomInt } from 'node:crypto';
import { currentOrgId, type Db } from '../db/pool.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';

/**
 * Named account numbers and the other words a paybill answers to (migration 052).
 *
 * A person may choose a name such as JOHN as their account number instead of, or as well as, the
 * digits Studio gave them. On a shared paybill a name must mean one account across every business and
 * app on it, so the table is organisation-wide and the rule lives in the database
 * (route_claim_conflict), which the insert trigger enforces under one lock. This file asks the same
 * function before it claims, so what it offers as free is what the database will accept.
 */
export type ClaimReason = 'taken' | 'held' | 'starts_with_prefix' | 'starts_with_code' | 'covers_claim' | 'covers_code';

export const NAME_MIN = 3;
/** Safaricom's account reference is at most twelve characters. */
export const NAME_MAX = 12;

/** What the owner and the payer read, one sentence per reason. */
export const REASON_WORDS: Record<ClaimReason | 'invalid', string> = {
  taken: 'Somebody on this paybill already uses that name.',
  held: 'That name was in use recently, so it is kept back for a while in case a payer still types it.',
  starts_with_prefix: 'That name starts the way an app’s payments start, so a payment to it could go to the app.',
  starts_with_code: 'That name starts with a business code, so a payment to it could go to that business.',
  covers_claim: 'That would be the start of a name already in use.',
  covers_code: 'That would be the start of a business code.',
  invalid: 'A name is 3 to 12 letters and digits, with at least one letter.',
};

/** Upper-cased and checked, or null when it can never be a name. `john` and `JOHN` are the same name. */
export function normalizeName(raw: string): string | null {
  const name = String(raw ?? '').trim().toUpperCase();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return null;
  if (!/^[A-Z0-9]+$/.test(name) || !/[A-Z]/.test(name)) return null;
  return name;
}

export type Rng = (maxExclusive: number) => number;

/**
 * Candidates for a name that is not free: the name with digits at the end or the start (JOHN7,
 * JOHN24, 7JOHN), shortened when the name is already long, in a random order so two people refused
 * the same name are not offered the same list.
 */
export function candidates(name: string, rng: Rng = randomInt): string[] {
  const out = new Set<string>();
  const digits = (n: number) => String(rng(10 ** n)).padStart(n, '0');
  for (let i = 0; out.size < 24 && i < 200; i++) {
    const n = 1 + (i % 3);
    const d = n === 1 ? String(1 + rng(9)) : digits(n);
    const base = name.slice(0, NAME_MAX - d.length);
    const c = i % 4 === 3 ? d + base : base + d;
    if (normalizeName(c) === c && c !== name) out.add(c);
  }
  return [...out];
}

export interface NameCheck { name: string | null; available: boolean; reason: ClaimReason | 'invalid' | null; message: string | null; suggestions: string[] }
export interface ClaimActor { personId: string | null; apiKeyId?: string | null; ip: string }

export interface ClaimsService {
  /** Whether a name is free for this account (or for anyone, with no account), and what is, if not. */
  check(raw: string, accountId?: string | null): Promise<NameCheck>;
  /** Give an account this name. Its old name, if it had one, is released. */
  claimName(accountId: string, raw: string, actor: ClaimActor): Promise<{ name: string }>;
  releaseName(accountId: string, actor: ClaimActor): Promise<void>;
}

function org(): string {
  const id = currentOrgId();
  if (!id) throw new Error('no organisation in scope');
  return id;
}

export async function conflictOf(db: { query: Db['query'] }, token: string, kind: 'prefix' | 'alias' | 'name', accountId: string | null = null): Promise<ClaimReason | null> {
  const [row] = await db.query<{ why: ClaimReason | null }>(`SELECT route_claim_conflict($1, $2, $3, $4) AS why`, [org(), token, kind, accountId]);
  return row?.why ?? null;
}

export function createClaimsService(deps: { db: Db; rng?: Rng }): ClaimsService {
  const rng = deps.rng ?? randomInt;

  async function suggestions(name: string, accountId: string | null): Promise<string[]> {
    const free: string[] = [];
    for (const c of candidates(name, rng)) {
      if (!(await conflictOf(deps.db, c, 'name', accountId))) free.push(c);
      if (free.length === 5) break;
    }
    return free;
  }

  async function ownName(accountId: string): Promise<string | null> {
    const [row] = await deps.db.query<{ token: string }>(
      `SELECT token FROM route_claims WHERE account_id=$1 AND kind='name' AND released_at IS NULL`, [accountId]);
    return row?.token ?? null;
  }

  async function check(raw: string, accountId: string | null = null): Promise<NameCheck> {
    const name = normalizeName(raw);
    if (!name) return { name: null, available: false, reason: 'invalid', message: REASON_WORDS.invalid, suggestions: [] };
    if (accountId && (await ownName(accountId)) === name) return { name, available: true, reason: null, message: null, suggestions: [] };
    const why = await conflictOf(deps.db, name, 'name', accountId);
    if (!why) return { name, available: true, reason: null, message: null, suggestions: [] };
    return { name, available: false, reason: why, message: REASON_WORDS[why], suggestions: await suggestions(name, accountId) };
  }

  return {
    check,
    async claimName(accountId, raw, actor) {
      const name = normalizeName(raw);
      if (!name) throw new HttpError(400, 'bad_name', REASON_WORDS.invalid);
      const [account] = await deps.db.query<{ id: string; business_id: string }>(`SELECT id, business_id FROM accounts WHERE id=$1`, [accountId]);
      if (!account) throw new HttpError(404, 'not_found', 'That account does not exist.');
      const before = await ownName(accountId);
      if (before === name) return { name };
      const refused = async (why: ClaimReason) =>
        new HttpError(409, 'name_taken', REASON_WORDS[why], { reason: why, suggestions: await suggestions(name, accountId) });
      try {
        await deps.db.tx(async (c) => {
          await c.query(`SELECT pg_advisory_xact_lock(hashtext('route_claims:' || $1))`, [org()]);
          const [r] = (await c.query<{ why: ClaimReason | null }>(`SELECT route_claim_conflict($1, $2, 'name', $3) AS why`, [org(), name, accountId])).rows;
          if (r?.why) throw await refused(r.why);
          await c.query(`UPDATE route_claims SET released_at=now() WHERE account_id=$1 AND kind='name' AND released_at IS NULL`, [accountId]);
          await c.query(`INSERT INTO route_claims(token, kind, business_id, account_id) VALUES ($1, 'name', $2, $3)`, [name, account.business_id, accountId]);
        });
      } catch (e) {
        // Two people choosing one name at once: the database let one through and refused the other.
        if ((e as { code?: string }).code === '23505') throw await refused(((e as { hint?: string }).hint as ClaimReason) || 'taken');
        throw e;
      }
      await audit(deps.db, { personId: actor.personId, ip: actor.ip, action: 'account.named', target: accountId, before: { name: before }, after: { name, byKey: actor.apiKeyId ?? null } });
      return { name };
    },
    async releaseName(accountId, actor) {
      const before = await ownName(accountId);
      if (!before) return;
      await deps.db.query(`UPDATE route_claims SET released_at=now() WHERE account_id=$1 AND kind='name' AND released_at IS NULL`, [accountId]);
      await audit(deps.db, { personId: actor.personId, ip: actor.ip, action: 'account.name_released', target: accountId, before: { name: before }, after: { byKey: actor.apiKeyId ?? null } });
    },
  };
}

/**
 * The account or business a whole reference names by a word (migration 052): a person's chosen name,
 * or an alias for a business or an app. Case does not matter. Null when no live word matches, and the
 * reference is then read as Studio's digits.
 */
export async function matchWord(db: { query: (text: string, values?: unknown[]) => Promise<unknown[]> }, reference: string | null | undefined):
  Promise<{ businessId: string; accountId: string | null } | null> {
  const token = String(reference ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(token) || !/[A-Z]/.test(token)) return null;
  const [row] = (await db.query(
    `SELECT COALESCE(c.business_id, a.business_id) AS business_id, c.account_id
       FROM route_claims c LEFT JOIN apps a ON a.id = c.app_id
      WHERE c.token = $1 AND c.kind IN ('name', 'alias') AND c.released_at IS NULL`, [token])) as { business_id: string | null; account_id: string | null }[];
  return row?.business_id ? { businessId: row.business_id, accountId: row.account_id } : null;
}
