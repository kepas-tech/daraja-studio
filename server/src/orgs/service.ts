import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { currentOrgId, isSystem, withOrg, withSystem } from '../db/pool.js';
import { MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { PLAIN_USERNAME, USERNAME_SHAPE, USERNAME_TAKEN, usernameTaken, writeOwner, type OwnerRow } from '../people/owner.js';
import { decryptForOrg, deriveOrgKey, encryptWithOrgKey, randomSecret, sha256, type Keyring } from '../crypto/secrets.js';
import { closeOrg } from './close.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { CLOSED_CHILD_TABLES } from './close.js';

/**
 * The name an organisation starts with, before anybody has named it: the boot pass gives it to
 * organisation #1 and a wipe puts it back. It is not a name the install "has" — anything showing a
 * studio's own name to somebody has to treat this as no name at all.
 */
export const DEFAULT_ORG_NAME = 'My organisation';

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

/** The first owner of an organisation being stood up: who they are and the password they start with. */
export interface ProvisionOwnerInput { username: string; displayName: string; password: string }
export interface ProvisionOrgInput {
  name: string;
  owner: ProvisionOwnerInput;
  /** The address the sign-up came from, kept for abuse review. Never shown to a tenant. */
  signupIp: string | null;
}
/**
 * What provisioning answers. A refusal is plain and leaves nothing behind: the username is asked
 * about before anything is written, and the transaction is rolled back if the index disagrees.
 */
export type ProvisionOrgResult =
  | { ok: true; org: OrgView; person: OwnerRow; secret: string }
  | { ok: false; problem: 'username_taken' | 'invalid'; message: string };

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

// No 0/o/1/l: the slug ends up in a host-admin URL that somebody may read out loud.
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function slugFor(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
  let suffix = '';
  for (const b of randomBytes(4)) suffix += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return `${base}-${suffix}`;
}

export interface WipeActor { personId: string | null; ip?: string }

export interface OrgService {
  /**
   * The owner's own reset: every table that hangs off the organisation goes (credentials, people,
   * history, sessions), the audit trail stays, and the `orgs` row is put back to a fresh `pending`
   * one with the same id, so the next visit shows first-run setup without a restart.
   */
  wipe(orgId: string, confirmName: string, actor: WipeActor): Promise<void>;
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
  /**
   * An organisation and its first owner, in one transaction: the pair is written or neither is.
   *
   * This is the way a caller that is not the studio's own setup stands a tenant up. The owner is
   * written through the same code the setup wizard uses (`people/owner.ts`), so nobody outside the
   * studio hashes a password or writes to the people table. A username already taken anywhere on
   * the install is a plain refusal, asked before anything is written, so a refusal leaves no
   * organisation behind.
   */
  provision(input: ProvisionOrgInput): Promise<ProvisionOrgResult>;
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

    async provision(input) {
      const name = String(input?.name ?? '').trim();
      if (name.length < 1 || name.length > 120) {
        return { ok: false, problem: 'invalid', message: 'An organisation needs a name of one to 120 characters.' };
      }
      const username = String(input?.owner?.username ?? '').trim().toLowerCase();
      if (!PLAIN_USERNAME.test(username)) return { ok: false, problem: 'invalid', message: USERNAME_SHAPE };
      const displayName = String(input?.owner?.displayName ?? '').trim();
      if (displayName.length < 1 || displayName.length > 120) {
        return { ok: false, problem: 'invalid', message: 'The first person needs a name of one to 120 characters.' };
      }
      const password = String(input?.owner?.password ?? '');
      if (password.length < MIN_PASSWORD_LENGTH || password.length > 512) {
        return { ok: false, problem: 'invalid', message: 'A password is ' + MIN_PASSWORD_LENGTH + ' characters or more.' };
      }

      // The id and the salt are minted here, exactly as create() does: this organisation's key has
      // to exist before its row does.
      const id = randomUUID();
      const salt = randomBytes(32);
      const secret = randomSecret(32);
      const hash = sha256(secret);
      const enc = encryptWithOrgKey(deriveOrgKey(deps.master, id, salt), secret);

      // Up to five tries, and only ever for the slug: slugFor mixes in four random bytes, so a fresh
      // suffix clears a collision almost certainly on the next attempt. The whole transaction is
      // retried rather than one statement, because a conflict inside a transaction ends it.
      for (let attempt = 0; attempt < 5; attempt++) {
        const outcome = await withSystem(() => deps.db.tx(async (c) => {
          // The username is unique across the whole install and the people table is scoped to one
          // organisation, so the question is asked from outside all of them — and asked first, so a
          // taken username leaves nothing at all behind rather than an organisation with nobody in
          // it.
          if (await usernameTaken(c, username)) return { taken: true } as const;
          const inserted = await c.query<OrgRow>(
            `INSERT INTO orgs(id, slug, name, status, callback_secret_hash, callback_secret_enc, key_salt, signup_ip)
             VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
             ON CONFLICT (slug) DO NOTHING
             RETURNING id, slug, name, status, is_host, suspend_reason`,
            [id, slugFor(name), name, hash, enc, salt, input.signupIp]);
          if (!inserted.rows[0]) return { slug: true } as const;
          // The studio's own way of writing an owner, so nothing outside the studio ever hashes a
          // password or writes this row itself.
          const person = await writeOwner(c, { orgId: id, username, displayName, password, mustChangePassword: true });
          return { org: inserted.rows[0], person } as const;
        })).catch((e: unknown) => {
          // The check above is friendly, not sufficient: two callers can pass it at once and only
          // one insert wins. The index refuses the second, the transaction is rolled back, and the
          // organisation goes with it — so the pair is still made or neither is.
          if (isUniqueViolation(e)) return { taken: true } as const;
          throw e;
        });
        if ('taken' in outcome) return { ok: false, problem: 'username_taken', message: USERNAME_TAKEN };
        if ('slug' in outcome) continue;
        return { ok: true, org: toView(outcome.org), person: outcome.person, secret };
      }
      throw new HttpError(503, 'org_not_created', 'Could not create the organisation just now. Try again.');
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

    async wipe(orgId, confirmName, actor) {
      const org = await this.byId(orgId);
      if (!org) throw new HttpError(404, 'not_found', 'No organisation.');
      if (confirmName.trim() !== org.name) throw new HttpError(400, 'confirm_name', 'Type the organisation name exactly to confirm.');
      // Written first, in the organisation's own scope: audit rows survive the wipe on purpose.
      await audit(deps.db, { personId: actor.personId, action: 'org.wiped', target: orgId, before: { name: org.name }, ip: actor.ip });
      await withSystem(() => deps.db.tx(async (c) => {
        for (const table of CLOSED_CHILD_TABLES) await c.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
        await c.query(`DELETE FROM jobs WHERE payload->>'orgId' = $1`, [orgId]);
        await c.query(`DELETE FROM cache WHERE key LIKE 'org:' || $1 || ':%'`, [orgId]);
        await c.query(`UPDATE orgs SET status = 'pending', name = $2, fail_reason = NULL, suspend_reason = NULL WHERE id = $1`, [orgId, DEFAULT_ORG_NAME]);
      }));
    },
    async close(orgId, reason) {
      // A sign-up's failure path only ever reaches this while its organisation is still the
      // `pending` row it created moments earlier — nothing else has had a chance to move it on.
      await closeOrg(deps.db, orgId, reason, ['pending']);
    },
  };
}
