import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import { decryptForOrg, encryptForOrg, type Keyring } from '../crypto/secrets.js';

export type Env = 'sandbox' | 'production';
const ENVS: readonly Env[] = ['sandbox', 'production'];
type EnvSlotKey = 'shortcode' | 'consumerKey' | 'consumerSecret' | 'credsVerifiedAt' | 'passkey' | 'certPem'
  | 'b2cApi' | 'b2cApiDetected' | 'b2cApiDetectedAt'
  // Sign-up (spec 4.2): the sha256 of the consumer key, which settings_consumer_key_uniq makes one
  // organisation's alone; the name Safaricom returned for the shortcode; and when the person
  // confirmed that name is theirs.
  | 'consumerKeyHash' | 'safaricomName' | 'shortcodeConfirmedAt'
  // Whether Safaricom answered for the number as a paybill or a till, learned when the name was checked.
  | 'shortcodeKind'
  // When a real STK push was accepted by Safaricom on this shortcode. A passkey cannot be checked
  // any other way: no read-only Daraja call uses it, so the only proof it is right is Safaricom
  // accepting a push. Until this is set, the passkey is stored but unproven, and nothing may claim
  // "Ask a customer to pay" works.
  | 'passkeyProvenAt'
  // Money in (M2): when the C2B addresses and the Pull address were registered, and the last check.
  | 'c2bRegisteredAt' | 'pullRegisteredAt' | 'pullCheckedAt'
  // Invoices (M7): Bill Manager's app key (encrypted) and the opt-in details.
  | 'billManagerAppKey' | 'billManagerOptedInAt' | 'billManagerEmail' | 'billManagerPhone' | 'billManagerReminders';
export type EnvSettingKey = `env.${Env}.${EnvSlotKey}`;

export type SettingKey =
  | 'org.name' | 'org.nominatedNumber' | 'org.notificationPhone'
  | 'daraja.environment'
  | 'public.url' | 'public.verifiedAt'
  | 'callbacks.allowlist' | 'setup.completedAt' | 'setup.step' | 'setup.probeRequestId'
  // What the business said it needs, in its own terms, asked once during setup. These decide which
  // credentials are required, so nobody is asked for a passkey to run a payroll, or walked past the
  // one step their shop actually depends on. 'true'/'false'.
  | 'use.payOut' | 'use.collect' | 'use.stk'
  // The business's own payment categories, a JSON list (see settings/categories.ts).
  | 'send.categories'
  // M4: sends at or above this many cents wait for a second person. 0 or unset = off.
  | 'send.approvalThresholdCents'
  | EnvSettingKey;

const ENCRYPTED_SLOTS = ['consumerKey', 'consumerSecret', 'passkey', 'certPem', 'billManagerAppKey'] as const;
export const ENCRYPTED_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>(
  ENVS.flatMap((e) => ENCRYPTED_SLOTS.map((k) => `env.${e}.${k}` as SettingKey)),
);

export interface Settings {
  get(key: SettingKey): Promise<string | null>;
  getMany(keys: SettingKey[]): Promise<Record<string, string | null>>;
  set(key: SettingKey, value: string): Promise<void>;
  delete(key: SettingKey): Promise<void>;
}

/**
 * The organisation every call below belongs to. RLS already scopes every one of these
 * statements, but the admin pool (a superuser) bypasses RLS entirely and the boot pass and tests
 * use it — so every statement here also carries an explicit `org_id = $n`, and a call with no
 * organisation in scope (and no pool fallback) throws rather than querying (design decision).
 */
function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

export function createSettings(db: Db, keyring: Keyring): Settings {
  const unpack = (row: { value: string; encrypted: boolean }): Promise<string> =>
    row.encrypted ? decryptForOrg(keyring, row.value) : Promise.resolve(row.value);
  return {
    async get(key) {
      const orgId = requireOrg();
      const rows = await db.query<{ value: string; encrypted: boolean }>(
        'SELECT value, encrypted FROM settings WHERE org_id = $1 AND key = $2',
        [orgId, key],
      );
      return rows[0] ? await unpack(rows[0]) : null;
    },
    async getMany(keys) {
      const orgId = requireOrg();
      const rows = await db.query<{ key: string; value: string; encrypted: boolean }>(
        'SELECT key, value, encrypted FROM settings WHERE org_id = $1 AND key = ANY($2)',
        [orgId, keys],
      );
      const out: Record<string, string | null> = {};
      for (const k of keys) out[k] = null;
      for (const r of rows) out[r.key] = await unpack(r);
      return out;
    },
    async set(key, value) {
      const orgId = requireOrg();
      const encrypted = ENCRYPTED_KEYS.has(key);
      const stored = encrypted ? await encryptForOrg(keyring, value) : value;
      await db.query(
        `INSERT INTO settings(org_id, key, value, encrypted) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, key) DO UPDATE SET value=EXCLUDED.value, encrypted=EXCLUDED.encrypted, updated_at=now()`,
        [orgId, key, stored, encrypted],
      );
    },
    async delete(key) {
      const orgId = requireOrg();
      await db.query('DELETE FROM settings WHERE org_id = $1 AND key = $2', [orgId, key]);
    },
  };
}
