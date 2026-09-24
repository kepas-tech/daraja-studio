import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { ROLE_PRESETS } from '../permissions/roles.js';
import type { PermissionKey } from '../permissions/catalog.js';
import type { OrgView } from '../orgs/service.js';

/**
 * Round 3, phase E: API keys, so another system can call this studio.
 *
 * A key is `studio_<prefix>_<secret>`: the prefix is public and is what a list shows, the secret
 * is shown once at creation and stored only as a hash. A key carries a role, and that role's own
 * permissions are what it may call — so a key can never do more than the person who could log in
 * with the same role. It can do less in one way that matters: anything behind a password or a PIN
 * (sending money, reversing, changing settings) has no key equivalent and is refused.
 *
 * Nothing here is ever logged: not the key, not its hash, not a signature. Audit rows carry the
 * prefix and the name, which is what a person needs to recognise the key in a list.
 */
export type KeyRole = 'operator' | 'viewer' | 'approver' | 'forwarder' | 'collector';
export const KEY_ROLES: readonly KeyRole[] = ['operator', 'viewer', 'approver', 'forwarder', 'collector'];

export interface ApiKeyView {
  id: string; name: string; prefix: string; role: KeyRole;
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
  rotatedFrom: string | null;
  /** Migration 050: the business this key acts for, when it has one. */
  businessId: string | null;
  createdBy: { id: string; displayName: string } | null;
}
/** The one response that carries the secret. Every other read of a key shows the prefix alone. */
export interface ApiKeyCreated { key: ApiKeyView; secret: string }
export interface KeyActor { personId: string; ip: string }

export interface KeyAuth {
  keyId: string; name: string; prefix: string; role: KeyRole;
  permissions: PermissionKey[];
  businessId: string | null;
  org: OrgView;
}

export interface ApiKeysService {
  list(): Promise<ApiKeyView[]>;
  create(input: { name: string; role: KeyRole; businessId?: string | null }, actor: KeyActor): Promise<ApiKeyCreated>;
  /** A new secret for the same name and role; the old key stops working in the same breath. */
  rotate(id: string, actor: KeyActor): Promise<ApiKeyCreated>;
  revoke(id: string, actor: KeyActor): Promise<ApiKeyView>;
  /** The key behind a bearer token, or null. Runs with the system context: the key names its org. */
  authenticate(secret: string): Promise<KeyAuth | null>;
}

interface KeyRow {
  id: string; name: string; prefix: string; key_hash: string; role: KeyRole;
  created_at: Date; last_used_at: Date | null; revoked_at: Date | null; rotated_from: string | null;
  created_by: string | null; created_by_name: string | null; business_id: string | null;
}

const PREFIX_BYTES = 6;   // 12 hex characters
const SECRET_BYTES = 32;  // 256 bits, base64url
const PREFIX_RE = /^[0-9a-f]{12}$/;
const USED_AT_MOST_EVERY_MS = 60_000;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const SELECT = `SELECT k.id, k.name, k.prefix, k.key_hash, k.role, k.created_at, k.last_used_at, k.revoked_at,
       k.rotated_from, k.created_by, p.display_name AS created_by_name, k.business_id
  FROM api_keys k LEFT JOIN people p ON p.id = k.created_by`;

function view(r: KeyRow): ApiKeyView {
  return {
    id: r.id, name: r.name, prefix: r.prefix, role: r.role,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    rotatedFrom: r.rotated_from,
    businessId: r.business_id ?? null,
    createdBy: r.created_by ? { id: r.created_by, displayName: r.created_by_name ?? '' } : null,
  };
}

function mint(): { prefix: string; secret: string; token: string; hash: string } {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { prefix, secret, token: `studio_${prefix}_${secret}`, hash: sha256(secret) };
}

export function createApiKeysService({ db }: { db: Db }): ApiKeysService {
  async function load(id: string): Promise<KeyRow> {
    const [row] = await db.query<KeyRow>(`${SELECT} WHERE k.id = $1`, [id]);
    if (!row) throw new HttpError(404, 'not_found', 'That key does not exist.');
    return row;
  }

  /** One insert, in whatever context the caller is already in, so create and rotate share it. */
  async function issue(input: { name: string; role: KeyRole; createdBy: string; rotatedFrom?: string | null; businessId?: string | null }): Promise<ApiKeyCreated> {
    const minted = mint();
    const [row] = await db.query<{ id: string }>(
      `INSERT INTO api_keys(name, prefix, key_hash, role, created_by, rotated_from, business_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.name, minted.prefix, minted.hash, input.role, input.createdBy, input.rotatedFrom ?? null, input.businessId ?? null],
    );
    const created = await load(row!.id);
    // The secret is returned to the caller and never stored or logged; `view` cannot carry it.
    return { key: view(created), secret: minted.token };
  }

  return {
    async list() {
      const rows = await db.query<KeyRow>(`${SELECT} ORDER BY k.created_at DESC`);
      return rows.map(view);
    },

    async create(input, actor) {
      if (input.businessId) {
        const [biz] = await db.query<{ id: string }>('SELECT id FROM businesses WHERE id = $1', [input.businessId]);
        if (!biz) throw new HttpError(400, 'unknown_business', 'That business does not exist.');
      }
      const made = await issue({ name: input.name, role: input.role, createdBy: actor.personId, businessId: input.businessId ?? null });
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'api_key.created', target: made.key.id, after: { name: made.key.name, prefix: made.key.prefix, role: made.key.role, businessId: made.key.businessId } });
      return made;
    },

    async rotate(id, actor) {
      const old = await load(id);
      if (old.revoked_at) throw new HttpError(409, 'revoked', 'That key has been revoked. Make a new one instead.');
      const made = await issue({ name: old.name, role: old.role, createdBy: actor.personId, rotatedFrom: old.id, businessId: old.business_id });
      // The old key stops working here, in the same breath as the new one starting.
      await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'api_key.rotated', target: made.key.id, before: { prefix: old.prefix }, after: { prefix: made.key.prefix, name: made.key.name, role: made.key.role } });
      return made;
    },

    async revoke(id, actor) {
      const row = await load(id);
      if (row.revoked_at) return view(row);
      await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'api_key.revoked', target: id, after: { prefix: row.prefix, name: row.name } });
      return view(await load(id));
    },

    async authenticate(secret) {
      // Cut at the first two `_` characters only: the secret half is base64url, whose own alphabet
      // includes `_`, so splitting on every one would cut a key in the wrong place about half the time.
      const first = secret.indexOf('_');
      const second = first < 0 ? -1 : secret.indexOf('_', first + 1);
      const head = first < 0 ? '' : secret.slice(0, first);
      const prefix = second < 0 ? '' : secret.slice(first + 1, second);
      const body = second < 0 ? '' : secret.slice(second + 1);
      if (second < 0 || head !== 'studio' || !PREFIX_RE.test(prefix) || !body) return null;
      const [row] = await db.query<KeyRow & { org_id: string; org_slug: string; org_name: string; org_status: OrgView['status']; org_is_host: boolean; org_suspend_reason: OrgView['suspendReason'] }>(
        `SELECT k.id, k.name, k.prefix, k.key_hash, k.role, k.created_at, k.last_used_at, k.revoked_at, k.rotated_from,
                k.created_by, NULL::text AS created_by_name, k.business_id,
                o.id AS org_id, o.slug AS org_slug, o.name AS org_name, o.status AS org_status,
                o.is_host AS org_is_host, o.suspend_reason AS org_suspend_reason
           FROM api_keys k JOIN orgs o ON o.id = k.org_id WHERE k.prefix = $1`,
        [prefix],
      );
      if (!row || row.revoked_at) return null;
      const given = Buffer.from(sha256(body), 'hex');
      const stored = Buffer.from(row.key_hash, 'hex');
      if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
      // One write a minute at most: a busy key must not turn every call into a row update.
      if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > USED_AT_MOST_EVERY_MS) {
        await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
      }
      return {
        keyId: row.id, name: row.name, prefix: row.prefix, role: row.role,
        permissions: ROLE_PRESETS[row.role],
        businessId: row.business_id ?? null,
        org: { id: row.org_id, slug: row.org_slug, name: row.org_name, status: row.org_status, isHost: row.org_is_host, suspendReason: row.org_suspend_reason },
      };
    },
  };
}

/** The org a key belongs to, for a route that needs it without a session. */
export const currentKeyOrg = () => currentOrgId();
