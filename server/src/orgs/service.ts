import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { currentOrgId, isSystem, withOrg, withSystem } from '../db/pool.js';
import { decryptForOrg, deriveOrgKey, encryptWithOrgKey, randomSecret, sha256, type Keyring } from '../crypto/secrets.js';
import { closeOrg } from './close.js';
import { HttpError } from '../util/errors.js';

export type OrgStatus = 'pending' | 'creds_ok' | 'operator_probing' | 'verified' | 'failed' | 'suspended' | 'closed';

export interface OrgView {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  isHost: boolean;
  /** Why this organisation is read-only, when it is. `null` for every other status. */
  suspendReason: 'unpaid' | 'host' | null;
}

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: OrgStatus;
  is_host: boolean;
  suspend_reason: 'unpaid' | 'host' | null;
}

const SELECT = 'SELECT id, slug, name, status, is_host, suspend_reason FROM orgs';

function toView(r: OrgRow): OrgView {
  return { id: r.id, slug: r.slug, name: r.name, status: r.status, isHost: r.is_host, suspendReason: r.suspend_reason };
}

export interface CreateOrgInput {
  name: string;
  /** The address the sign-up came from, kept for abuse review (spec 4.4). Never shown to a tenant. */
  signupIp: string | null;
}
export interface CreatedOrg {
  org: OrgView;
  /** The plaintext callback secret, returned once. Never logged, never returned again except through revealSecret. */
  secret: string;
}

// No 0/o/1/l: the slug ends up in a host-admin URL that somebody may read out loud.
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function slugFor(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
  let suffix = '';
  for (const b of randomBytes(4)) suffix += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return `${base}-${suffix}`;
}

export interface OrgService {
  byId(id: string): Promise<OrgView | null>;
  /** The callback router's lookup: sha256 of the secret in the URL. */
  bySecretHash(hash: string): Promise<OrgView | null>;
  /** The organisation's own callback secret, for Settings › reveal. Never logged. */
  revealSecret(orgId: string): Promise<string>;
  /**
   * A brand-new `pending` organisation with its own callback secret and derived key, written by one
   * INSERT inside `withSystem`. Migration 007's `org_self` policy is what stops a request context
   * creating one; no privileged connection is involved.
   */
  create(input: CreateOrgInput): Promise<CreatedOrg>;
  /** Move one organisation through its own state machine. Runs inside that organisation. */
  setStatus(orgId: string, status: OrgStatus, opts?: { failReason?: string | null }): Promise<void>;
  /**
   * Close an organisation: take its rows and its credentials away and leave the `orgs` row itself,
   * with a reason, plus every `audit_log` row (spec 4.4). Used only by a sign-up that fails its
   * very first step, while the organisation is still `pending` — the hourly sweep calls
   * `closeOrg` itself, with its own wider set of statuses, since it is closing a row it does not
   * know is still in the state it was listed in.
   */
  close(orgId: string, reason: string | null): Promise<void>;
}

export function createOrgService(deps: { db: Db; keyring: Keyring; master: Buffer }): OrgService {
  return {
    // The three methods 3A already wrote, unchanged apart from the widened SELECT list above.
    async byId(id) {
      const rows = await withSystem(() => deps.db.query<OrgRow>(`${SELECT} WHERE id = $1`, [id]));
      return rows[0] ? toView(rows[0]) : null;
    },
    async bySecretHash(hash) {
      const rows = await withSystem(() => deps.db.query<OrgRow>(`${SELECT} WHERE callback_secret_hash = $1`, [hash]));
      return rows[0] ? toView(rows[0]) : null;
    },
    async revealSecret(orgId) {
      // Never let one organisation's context reveal another's secret by simply passing its id:
      // only that organisation's own context, or the system role (migrations, the boot pass),
      // may ask.
      if (currentOrgId() !== orgId && !isSystem()) throw new HttpError(500, 'org_mismatch', 'organisation mismatch');
      // Read and decrypt inside the organisation: the org_self policy allows its own row, and the
      // v2 ciphertext only opens under that organisation's key. Another organisation's row is
      // invisible here, so this throws rather than returning someone else's secret.
      return withOrg(orgId, async () => {
        const rows = await deps.db.query<{ callback_secret_enc: string }>('SELECT callback_secret_enc FROM orgs WHERE id = $1', [orgId]);
        if (!rows[0]) throw new Error('no such organisation');
        return decryptForOrg(deps.keyring, rows[0].callback_secret_enc);
      });
    },

    async create(input) {
      // The id and the salt are minted here, not by the database, so this organisation's key can be
      // derived before its row exists — which is what lets the whole row, ciphertext included, be
      // written by one statement. `createDbKeyring` later derives the identical key from the stored
      // key_salt, because deriveOrgKey is a pure function of (master, id, salt).
      const id = randomUUID();
      const salt = randomBytes(32);
      const secret = randomSecret(32);
      const hash = sha256(secret);
      const enc = encryptWithOrgKey(deriveOrgKey(deps.master, id, salt), secret);
      // ON CONFLICT (slug) DO NOTHING covers only the one collision worth a silent retry: `slugFor`
      // mixes in four random bytes, so a fresh suffix clears it almost certainly on the next
      // attempt. Naming no target (or the other unique constraints on this row — callback_secret_hash,
      // the partial orgs_single_host index) would retry those too, masking a real problem — a broken
      // random source, a second `is_host` row racing this one — behind up to five silent attempts and
      // a misleading 503. Only the slug is regenerated on retry: the id, salt, secret and ciphertext
      // all belong together and are never recomputed.
      let row: OrgRow | undefined;
      for (let attempt = 0; attempt < 5 && !row; attempt++) {
        const inserted = await withSystem(() =>
          deps.db.query<OrgRow>(
            `INSERT INTO orgs(id, slug, name, status, callback_secret_hash, callback_secret_enc, key_salt, signup_ip)
             VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
             ON CONFLICT (slug) DO NOTHING
             RETURNING id, slug, name, status, is_host, suspend_reason`,
            [id, slugFor(input.name), input.name, hash, enc, salt, input.signupIp],
          ),
        );
        row = inserted[0];
      }
      if (!row) throw new HttpError(503, 'org_not_created', 'Could not create the organisation just now. Try again.');
      return { org: toView(row), secret };
    },

    async setStatus(orgId, status, opts = {}) {
      // `closed` is terminal (spec 4.1): once an organisation is closed its child rows are already
      // gone, so nothing may move it back into an active status. Suspension's own transitions stay
      // possible — a later phase gives suspension its own predicates rather than widening this one.
      await withOrg(orgId, async () => {
        if (opts.failReason === undefined) {
          await deps.db.query(`UPDATE orgs SET status = $2 WHERE id = $1 AND status <> 'closed'`, [orgId, status]);
        } else {
          await deps.db.query(`UPDATE orgs SET status = $2, fail_reason = $3 WHERE id = $1 AND status <> 'closed'`, [orgId, status, opts.failReason]);
        }
      });
    },

    async close(orgId, reason) {
      // A sign-up's failure path only ever reaches this while its organisation is still the
      // `pending` row it created moments earlier — nothing else has had a chance to move it on.
      await closeOrg(deps.db, orgId, reason, ['pending']);
    },
  };
}
