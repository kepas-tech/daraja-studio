import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { currentOrgId, withOrg, type Db } from '../db/pool.js';

const ALG = 'aes-256-gcm';
/** v1 = the install master key (legacy rows and instance_settings). v2 = a per-organisation key. */
type Version = 'v1' | 'v2';

function pack(key: Buffer, plain: string, version: Version): string {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Encrypt under a key you already hold, as v1. The master-key path: instance_settings and the boot pass. */
export function encrypt(key: Buffer, plain: string): string {
  return pack(key, plain, 'v1');
}

/**
 * Encrypt under an already-derived per-organisation key, as v2 — for the one caller that has to
 * derive that key itself: `orgs.create` computes `deriveOrgKey(master, id, salt)` before its row
 * exists, so `encryptForOrg`'s usual path (read `key_salt` back out of the row inside `withOrg`)
 * cannot run yet. `decryptForOrg` picks the derived-key path only for a `v2:` prefix, so this must
 * tag the same way `encryptForOrg` does, not `encrypt`'s `v1`.
 */
export function encryptWithOrgKey(key: Buffer, plain: string): string {
  return pack(key, plain, 'v2');
}

/**
 * Decrypt under a key you already hold. The version prefix selects the *key*, not the algorithm, and
 * the caller is the one who knows which key it is holding — so both versions are accepted here and
 * the GCM tag is what actually decides. The boot pass verifies its own re-encryption this way.
 */
export function decrypt(key: Buffer, packed: string): string {
  const parts = packed.split(':');
  if (parts.length !== 4) throw new Error('bad ciphertext format');
  const [v, ivB, tagB, ctB] = parts;
  // ctB may legitimately be '' — AES-GCM of an empty string has zero ciphertext bytes.
  if ((v !== 'v1' && v !== 'v2') || !ivB || !tagB || ctB === undefined) throw new Error('bad ciphertext format');
  const iv = Buffer.from(ivB, 'base64');
  // pack() always writes a 12-byte nonce. Anything else is not something this code produced, and
  // GCM's security argument is specific to a 96-bit nonce, so it is rejected rather than accepted.
  if (iv.length !== 12) throw new Error('bad ciphertext format');
  // authTagLength pins the tag at the full 16 bytes. Without it Node accepts a 4-byte GCM tag,
  // which a forger only has to guess one in 2^32 times.
  const d = createDecipheriv(ALG, key, iv, { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
}

/**
 * One organisation's key. HKDF-SHA256 with a per-organisation random salt and the organisation id in
 * `info`, so a ciphertext copied from one organisation to another fails to decrypt, and rotating one
 * organisation's key is re-encrypting that organisation's rows. The master key stays the root.
 */
export function deriveOrgKey(master: Buffer, orgId: string, salt: Buffer): Buffer {
  if (master.length !== 32) throw new Error('key must be 32 bytes');
  return Buffer.from(hkdfSync('sha256', master, salt, `daraja-studio/org/${orgId}`, 32));
}

/**
 * One process's derived-key cache. Memoisation in `keyFor` is per process: with more than one
 * application instance, rotating an organisation's key (spec §10.2 — re-encrypt under a new
 * `key_salt`, then `invalidate(orgId)`) clears the cache only on the instance that performed the
 * rotation. Every other instance keeps the pre-rotation key until its own process restarts, and would
 * write new `v2` rows under a key nobody else can read. Broadcasting the invalidation across
 * instances — `NOTIFY studio_events` through the existing hub is the obvious carrier — is planned
 * with rotation itself, not here; nothing in Phase 3A rotates.
 */
export interface Keyring {
  master: Buffer;
  keyFor(orgId: string): Promise<Buffer>;
  /** Forget one organisation's derived key, or, with no argument, all of them. Key rotation and tests. */
  invalidate(orgId?: string): void;
}

export function createKeyring(master: Buffer, loadSalt: (orgId: string) => Promise<Buffer>): Keyring {
  const keys = new Map<string, Buffer>();
  return {
    master,
    async keyFor(orgId) {
      const cached = keys.get(orgId);
      if (cached) return cached;
      const key = deriveOrgKey(master, orgId, await loadSalt(orgId));
      keys.set(orgId, key);
      return key;
    },
    invalidate(orgId) {
      if (orgId === undefined) keys.clear();
      else keys.delete(orgId);
    },
  };
}

/**
 * The keyring every caller wants. The salt is read inside that organisation's own context, which the
 * org_self policy allows, so no cross-organisation door is opened to fetch it.
 *
 * The lookup runs on its own pooled connection (`db.query`, not `db.tx`), so an organisation row
 * inserted inside an in-flight transaction is not visible here until that transaction commits.
 * A caller that creates an organisation must commit it before deriving or using its key.
 */
export function createDbKeyring(db: Db, master: Buffer): Keyring {
  return createKeyring(master, async (orgId) => {
    const rows = await withOrg(orgId, () => db.query<{ key_salt: Buffer }>('SELECT key_salt FROM orgs WHERE id = $1', [orgId]));
    if (!rows[0]) throw new Error(`no organisation ${orgId}`);
    return rows[0].key_salt;
  });
}

function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('cannot encrypt outside an organisation');
  return orgId;
}

/** Encrypt for the organisation in scope. Always v2. */
export async function encryptForOrg(keyring: Keyring, plain: string): Promise<string> {
  const orgId = requireOrg();
  return pack(await keyring.keyFor(orgId), plain, 'v2');
}

/** Decrypt whatever the row holds: v1 under the master key, v2 under the organisation in scope. */
export async function decryptForOrg(keyring: Keyring, packed: string): Promise<string> {
  if (packed.startsWith('v1:')) return decrypt(keyring.master, packed);
  const orgId = requireOrg();
  return decrypt(await keyring.keyFor(orgId), packed);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
