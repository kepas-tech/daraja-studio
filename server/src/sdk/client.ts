import { Daraja, type DarajaConfig } from '@kepas/daraja-js';
import type { Settings, Env } from '../settings/store.js';
import type { Cache } from '../db/cache.js';
import type { Db } from '../db/pool.js';
import { currentOrgId, withOrg } from '../db/pool.js';
import { decryptForOrg, sha256, type Keyring } from '../crypto/secrets.js';
import { HttpError } from '../util/errors.js';

export const PASSKEY_NOT_SET = 'not-set';

export interface DarajaFactory {
  /** Tier-A client, or the best verified operator attached when one exists. Never throws for a missing operator. */
  get(operatorId?: string): Promise<Daraja>;
  /** Tier-C client. Throws 409 `no_operator` unless a usable operator is attached. */
  getForOperator(operatorId?: string): Promise<Daraja>;
  /**
   * Forget one organisation's cached client (`orgId`), or every organisation's. **The no-argument
   * form is a full flush across every organisation this process has ever built a client for, and
   * that is deliberate.** `settings/service.ts` and `operators/service.ts` both call it bare on
   * every write, so in hosted mode one tenant's settings change evicts every other tenant's cached
   * client. Rebuilding is a handful of settings reads plus one decrypt, so the cost is a wasted
   * rebuild and nothing else — no isolation effect. Narrowing the default to the writing
   * organisation would change what `invalidate()` means for callers that rely on the flush
   * (`server/test/sdk-org.test.ts`), so it is not done.
   */
  invalidate(orgId?: string): void;
  stkEnabled(): Promise<boolean>;
  /**
   * What may honestly be said about "Ask a customer to pay".
   *
   * `off`      no passkey, so nothing can be attempted.
   * `unproven` a passkey is stored but Safaricom has never accepted a push with it. It may be wrong.
   * `proven`   Safaricom accepted a real push on this shortcode, so the passkey is right.
   *
   * `stkEnabled` deliberately stays a presence check: it answers "can we attempt one", which is
   * what the money path needs. This answers "may we tell the owner it works", which is not the
   * same question. Conflating them is what let a nine-character passkey show as ready.
   */
  stkStatus(): Promise<'off' | 'unproven' | 'proven'>;
  /**
   * A factory whose calls run inside `orgId`'s context, for callers outside a request .
   * Only the *build* runs inside that context — the `Daraja` object returned carries none, so a
   * caller that keeps it and calls it later (e.g. `client.b2c.send(...)`) must still be inside
   * `withOrg(orgId)` itself, or its token-store reads/writes land under the wrong cache prefix.
   */
  forOrg(orgId: string): Pick<DarajaFactory, 'get' | 'getForOperator' | 'stkEnabled' | 'stkStatus'>;
}

export const NO_OPERATOR_MESSAGE = 'Add or fix an API operator in Settings first.';

interface OperatorRow { id: string; name: string; credential_enc: string; status: string; environment: Env }

/** One built client per organisation, oldest evicted first. 500 is far beyond any real install. */
const MAX_CACHED_CLIENTS = 500;

/** What one environment slot has, and whether it is usable at all. */
export interface SlotReadiness {
  ready: boolean;
  credsVerified: boolean;
  hasPasskey: boolean;
  hasCredentials: boolean;
}

interface SlotValues {
  shortcode: string | null; consumerKey: string | null; consumerSecret: string | null; passkey: string | null; credsVerifiedAt: string | null;
}

/** The passkey counts only when it is a real value, never the `not-set` placeholder. */
const passkeySet = (v: string | null | undefined): boolean => !!v && v !== PASSKEY_NOT_SET;

/**
 * One read of an environment slot, shared by `slotConfig` and `slotReadiness` so the client and the
 * host settings screen can never disagree about what "ready" means. Credentials are only usable
 * once Safaricom has actually accepted them for this environment (settings/service.ts sets
 * `env.<mode>.credsVerifiedAt` on a successful oauthCheck) — a pair saved but never verified, or
 * verified and then invalidated by re-saving, must not be used silently.
 */
async function readSlot(settings: Settings, mode: Env): Promise<{ values: SlotValues; readiness: SlotReadiness }> {
  const s = await settings.getMany([
    `env.${mode}.shortcode`, `env.${mode}.consumerKey`, `env.${mode}.consumerSecret`,
    `env.${mode}.passkey`, `env.${mode}.credsVerifiedAt`,
  ]);
  const values: SlotValues = {
    shortcode: s[`env.${mode}.shortcode`],
    consumerKey: s[`env.${mode}.consumerKey`],
    consumerSecret: s[`env.${mode}.consumerSecret`],
    passkey: s[`env.${mode}.passkey`],
    credsVerifiedAt: s[`env.${mode}.credsVerifiedAt`],
  };
  const credsVerified = !!values.credsVerifiedAt;
  const hasPasskey = passkeySet(values.passkey);
  const hasCredentials = !!values.shortcode && !!values.consumerKey && !!values.consumerSecret;
  return { values, readiness: { ready: hasCredentials && credsVerified && hasPasskey, credsVerified, hasPasskey, hasCredentials } };
}

/**
 * The same test the client build applies, for callers that only report or validate a choice (the
 * host's billing settings, spec 6.1). Reads the organisation in scope.
 */
export async function slotReadiness(settings: Settings, mode: Env): Promise<SlotReadiness> {
  return (await readSlot(settings, mode)).readiness;
}

/**
 * One validated environment slot (review corrections B01 and W1-R3): the account identity and the
 * client built from exactly the values that produced it.
 *
 * `shortcode` says which account will collect, and `version` is a short hash of the slot's own
 * settings, so a replaced key, secret or passkey is visible without ever storing or returning a
 * secret. A payment attempt records the identity and dispatches with `client` from this same read,
 * so a concurrent settings change can never make the record name one account while the prompt uses
 * another. An incomplete identity throws before any client exists.
 */
export interface PreparedSlot { env: Env; shortcode: string; version: string; client: Daraja }

/** The identity hash of one slot's values. Never returned to a caller and never logged. */
function slotVersion(values: SlotValues): string {
  const material = [values.shortcode, values.consumerKey, values.consumerSecret, values.credsVerifiedAt, passkeySet(values.passkey) ? values.passkey : ''].map((v) => v ?? '').join('\u0000');
  return sha256(material).slice(0, 32);
}

/** The client configuration for values the caller has already read and validated. */
function slotConfigFrom(
  deps: { settings: Settings; cache: Cache; fetchImpl?: typeof fetch },
  mode: Env,
  values: SlotValues,
): Omit<DarajaConfig, 'initiator' | 'securityCredential'> {
  if (!values.shortcode || !values.consumerKey || !values.consumerSecret) {
    throw new HttpError(409, 'not_configured', `Enter the shortcode, Daraja key and secret for ${mode} in Settings.`);
  }
  if (!values.credsVerifiedAt) {
    throw new HttpError(409, 'not_configured', `The Daraja key and secret for ${mode} have not been accepted by Safaricom yet. Test them in Settings.`);
  }
  return {
    consumerKey: values.consumerKey, consumerSecret: values.consumerSecret,
    shortcode: values.shortcode, passkey: values.passkey || PASSKEY_NOT_SET,
    environment: mode,
    maxNetworkRetries: 2,
    tokenStore: {
      get: (k) => deps.cache.get<string>(`token:${k}`),
      set: (k, v, ttl) => deps.cache.set(`token:${k}`, v, ttl),
    },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
}

/**
 * Read one slot once and prepare the identity and client it names. The caller must already be
 * inside the owning organisation's context: the values are that organisation's settings.
 */
export async function prepareSlotClient(
  deps: { settings: Settings; cache: Cache; fetchImpl?: typeof fetch },
  env: Env,
): Promise<PreparedSlot> {
  const { values } = await readSlot(deps.settings, env);
  const client = new Daraja(slotConfigFrom(deps, env, values));
  return { env, shortcode: values.shortcode ?? '', version: slotVersion(values), client };
}

/** The Daraja configuration for one named environment slot, read from the organisation in scope. */
async function slotConfig(
  deps: { settings: Settings; cache: Cache; fetchImpl?: typeof fetch },
  mode: Env,
): Promise<Omit<DarajaConfig, 'initiator' | 'securityCredential'>> {
  const { values } = await readSlot(deps.settings, mode);
  return slotConfigFrom(deps, mode, values);
}

/**
 * A tier-A client for one named environment slot, for callers that must not follow
 * `daraja.environment` (spec 7.3: the host organisation's chosen `billing.env`). The caller must
 * already be inside `withOrg(hostOrgId)` — the slot values are that organisation's settings.
 *
 * Built fresh rather than cached: the factory's cache is keyed by organisation, a billing payment
 * is a handful of builds an hour, and the OAuth token itself still comes from the shared cache.
 */
export async function buildEnvClient(
  deps: { settings: Settings; cache: Cache; fetchImpl?: typeof fetch },
  env: Env,
): Promise<Daraja> {
  return (await prepareSlotClient(deps, env)).client;
}

export function createDarajaFactory(deps: { settings: Settings; cache: Cache; db: Db; keyring: Keyring; fetchImpl?: typeof fetch; maxCachedClients?: number }): DarajaFactory {
  // One process may now serve more than one organisation (hosted mode), so the cached client is
  // keyed by organisation as well as by the slot values that decide whether it is still current.
  const clients = new Map<string, { key: string; client: Daraja }>();
  // Overridable so a test can prove eviction without building hundreds of real clients.
  const maxCachedClients = deps.maxCachedClients ?? MAX_CACHED_CLIENTS;

  function requireOrg(): string {
    const orgId = currentOrgId();
    if (!orgId) throw new HttpError(500, 'no_org', 'No organisation is in scope for this Daraja call.');
    return orgId;
  }

  async function baseConfig(): Promise<{ cfg: Omit<DarajaConfig, 'initiator' | 'securityCredential'>; mode: Env }> {
    const modeSetting = await deps.settings.get('daraja.environment');
    const mode = modeSetting || 'sandbox';
    if (mode !== 'sandbox' && mode !== 'production') {
      throw new HttpError(409, 'not_configured', 'Environment must be sandbox or production. Check Settings.');
    }
    return { cfg: await slotConfig(deps, mode), mode };
  }

  async function pickOperator(mode: Env, operatorId?: string): Promise<OperatorRow | null> {
    if (operatorId) {
      const rows = await deps.db.query<OperatorRow>('SELECT id, name, credential_enc, status, environment FROM operators WHERE id=$1', [operatorId]);
      const op = rows[0];
      if (!op) throw new HttpError(404, 'operator_not_found', 'That operator does not exist.');
      // An operator from the other environment must never be paired with this mode's
      // shortcode/consumerKey/consumerSecret — checked before the status check below so a
      // wrong-environment failed/disabled operator reports the more specific error.
      if (op.environment !== mode) {
        throw new HttpError(409, 'wrong_environment', `Switch to ${op.environment} mode to use this operator.`);
      }
      if (op.status === 'failed' || op.status === 'disabled') {
        throw new HttpError(409, 'operator_unavailable', 'This operator is turned off or failed its last check. Fix it in Settings first.');
      }
      // 'pending' is allowed here — that's the probe path a freshly-rotated credential goes
      // through before it is marked verified. 'verified' is allowed too.
      return op;
    }
    const rows = await deps.db.query<OperatorRow>(
      `SELECT id, name, credential_enc, status, environment FROM operators WHERE status='verified' AND environment=$1 ORDER BY priority ASC, created_at ASC LIMIT 1`,
      [mode],
    );
    return rows[0] ?? null;
  }

  async function build(operatorId: string | undefined, requireOperator: boolean): Promise<Daraja> {
    const orgId = requireOrg();
    const { cfg, mode } = await baseConfig();
    const op = await pickOperator(mode, operatorId);
    if (requireOperator && !op) throw new HttpError(409, 'no_operator', `${NO_OPERATOR_MESSAGE} You are in ${mode} mode.`);
    const key = sha256(JSON.stringify([orgId, mode, cfg.consumerKey, cfg.consumerSecret, cfg.shortcode, cfg.passkey, op?.id ?? null, op?.credential_enc ?? null]));
    const hit = clients.get(orgId);
    if (hit && hit.key === key) {
      // Refresh its position so the least recently used organisation is the one evicted.
      clients.delete(orgId);
      clients.set(orgId, hit);
      return hit.client;
    }
    // The resulting client's `config` holds the plaintext consumer secret and (once an operator
    // is attached) the decrypted security credential — never log or JSON.stringify a Daraja client.
    const client = new Daraja(op
      ? { ...cfg, initiator: op.name, securityCredential: await decryptForOrg(deps.keyring, op.credential_enc) }
      : cfg);
    clients.delete(orgId);
    clients.set(orgId, { key, client });
    if (clients.size > maxCachedClients) {
      const oldest = clients.keys().next().value;
      if (oldest !== undefined) clients.delete(oldest);
    }
    return client;
  }

  const factory: DarajaFactory = {
    get: (operatorId) => build(operatorId, false),
    getForOperator: (operatorId) => build(operatorId, true),
    invalidate(orgId?: string) {
      if (orgId === undefined) clients.clear();
      else clients.delete(orgId);
    },
    async stkEnabled() {
      const mode = ((await deps.settings.get('daraja.environment')) as Env) || 'sandbox';
      const pk = await deps.settings.get(`env.${mode}.passkey`);
      return !!pk && pk !== PASSKEY_NOT_SET;
    },
    async stkStatus() {
      const mode = ((await deps.settings.get('daraja.environment')) as Env) || 'sandbox';
      const s = await deps.settings.getMany([`env.${mode}.passkey`, `env.${mode}.passkeyProvenAt`]);
      if (!passkeySet(s[`env.${mode}.passkey`])) return 'off';
      return s[`env.${mode}.passkeyProvenAt`] ? 'proven' : 'unproven';
    },
    /** The same three calls, bound to another organisation. For code that acts across organisations. */
    forOrg(orgId: string) {
      return {
        get: (operatorId?: string) => withOrg(orgId, () => factory.get(operatorId)),
        getForOperator: (operatorId?: string) => withOrg(orgId, () => factory.getForOperator(operatorId)),
        stkEnabled: () => withOrg(orgId, () => factory.stkEnabled()),
        stkStatus: () => withOrg(orgId, () => factory.stkStatus()),
      };
    },
  };
  return factory;
}
