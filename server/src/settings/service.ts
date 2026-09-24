import { Daraja, DarajaAPIError } from '@kepas/daraja-js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import type { Settings, Env } from './store.js';
import type { InstanceSettings } from './instance.js';
import type { Cache } from '../db/cache.js';
import type { DarajaFactory } from '../sdk/client.js';
import { PASSKEY_NOT_SET } from '../sdk/client.js';
import type { OperatorService, Actor, OperatorView } from '../operators/service.js';
import type { OrgService } from '../orgs/service.js';
import { currentCallbackSecret } from '../orgs/secret.js';
import { oauthCheck } from '../sdk/oauthCheck.js';
import { callbackUrls } from '../sdk/callbackUrls.js';
import { parseAllowlist } from '../callbacks/allowlist.js';
import { randomSecret, sha256 } from '../crypto/secrets.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';
import { parseCategories, validateCategories, type SendCategory } from './categories.js';

export type { Env, Actor };

// This file's own setDarajaCreds/setShortcode are the callers, so the copy lives wherever the
// write itself happens — the single writer of env.<e>.consumerKeyHash and env.<e>.shortcode
// respectively.
export const APP_TAKEN = 'This Daraja app already belongs to another organisation on this service.';
export const SHORTCODE_TAKEN = 'That shortcode already belongs to another organisation on this service.';
const UNIQUE_VIOLATION = '23505';

export interface SecretState { saved: boolean; last4: string | null }
export type B2cApiSetting = 'auto' | 'v1' | 'v3';
export interface EnvSlotView {
  shortcode: string | null;
  /** The name Safaricom returned when the shortcode was checked, and whether it answered as a paybill or a till. */
  safaricomName: string | null; shortcodeKind: 'paybill' | 'till' | null;
  consumerKey: SecretState; consumerSecret: SecretState; credsVerifiedAt: string | null;
  passkey: SecretState; passkeyProven: boolean; cert: SecretState;
  operators: OperatorView[];
  ready: { creds: boolean; operator: boolean };
  b2cApi: { setting: B2cApiSetting; detected: 'v1' | 'v3' | null; detectedAt: string | null };
}
export interface SettingsView {
  mode: Env;
  environments: Record<Env, EnvSlotView>;
  org: { name: string; nominatedNumber: string; notificationPhone: string };
  stkEnabled: boolean; publicUrl: string | null; publicVerifiedAt: string | null; httpsSeen: boolean;
  allowlist: string[]; setupCompletedAt: string | null;
  sendCategories: SendCategory[];
  /** M4: 0 = off. */
  approvalThresholdCents: number;
  /** What the business said it needs at setup; decides which Go live steps apply. */
  uses: { payOut: boolean; collect: boolean; stk: boolean };
}
export interface SettingsService {
  view(): Promise<SettingsView>;
  setOrg(input: { name: string; nominatedNumber: string; notificationPhone: string }, actor: Actor): Promise<void>;
  setShortcode(env: Env, shortcode: string, actor: Actor): Promise<{ verifiedName: string | null; verifyError: string | null }>;
  /** Ask Safaricom for the name behind the stored shortcode, as a paybill first, then as a till. Read only. */
  verifyShortcode(env: Env): Promise<{ verifiedName: string | null; verifyError: string | null }>;
  setMode(env: Env, confirmShortcode: string | undefined, actor: Actor): Promise<{ mode: Env; ready: { creds: boolean; operator: boolean } }>;
  setDarajaCreds(env: Env, key: string, secret: string, actor: Actor): Promise<{ ok: boolean; message: string }>;
  setPasskey(env: Env, passkey: string, actor: Actor): Promise<void>;
  setB2cApi(env: Env, version: B2cApiSetting, actor: Actor): Promise<void>;
  setAllowlist(list: string[], actor: Actor): Promise<void>;
  setPublicUrl(url: string, actor: Actor): Promise<void>;
  setApprovalThreshold(cents: number, actor: Actor): Promise<void>;
  testPublicUrl(): Promise<{ ok: boolean; detail: string }>;
  revealInstallSecret(actor: Actor): Promise<string>;
  getSendCategories(): Promise<SendCategory[]>;
  setSendCategories(items: { id?: string; name: string; commandId: string }[], actor: Actor): Promise<SendCategory[]>;
}

const ENVS: Env[] = ['sandbox', 'production'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createSettingsService(deps: { db: Db; config: Config; settings: Settings; instance: InstanceSettings; cache: Cache; daraja: DarajaFactory; operators: OperatorService; orgs: OrgService; fetchImpl?: typeof fetch }): SettingsService {
  const f = deps.fetchImpl ?? fetch;

  // Takes the slot's already-fetched credential fields rather than re-querying them, so a
  // caller that already has them (view(), looping over both environments) does not pay for the
  // same three settings rows twice.
  async function envReady(env: Env, creds: { consumerKey: string | null; consumerSecret: string | null; credsVerifiedAt: string | null }): Promise<{ creds: boolean; operator: boolean; operators: OperatorView[] }> {
    const operators = await deps.operators.list(env);
    return {
      creds: !!(creds.consumerKey && creds.consumerSecret && creds.credsVerifiedAt),
      operator: operators.some((o) => o.status === 'verified'),
      operators,
    };
  }

  const svc: SettingsService = {
    async view() {
      const shared = await deps.settings.getMany([
        'org.name', 'org.nominatedNumber', 'org.notificationPhone', 'daraja.environment',
        'public.url', 'public.verifiedAt', 'callbacks.allowlist', 'setup.completedAt', 'send.categories', 'send.approvalThresholdCents',
        'use.payOut', 'use.collect', 'use.stk',
      ]);
      // Install-wide, not per-organisation : lives in instance_settings, not settings.
      const httpsSeen = (await deps.instance.get('https.seen')) === 'true';
      const mode = ((shared['daraja.environment'] as Env) ?? 'sandbox');
      const environments = {} as Record<Env, EnvSlotView>;
      for (const e of ENVS) {
        const s = await deps.settings.getMany([`env.${e}.shortcode`, `env.${e}.consumerKey`, `env.${e}.consumerSecret`, `env.${e}.credsVerifiedAt`, `env.${e}.passkey`, `env.${e}.certPem`, `env.${e}.b2cApi`, `env.${e}.b2cApiDetected`, `env.${e}.b2cApiDetectedAt`, `env.${e}.safaricomName`, `env.${e}.shortcodeKind`, `env.${e}.passkeyProvenAt`]);
        const consumerKey = s[`env.${e}.consumerKey`];
        const { creds, operator, operators } = await envReady(e, { consumerKey, consumerSecret: s[`env.${e}.consumerSecret`], credsVerifiedAt: s[`env.${e}.credsVerifiedAt`] });
        const b2cApiSetting = s[`env.${e}.b2cApi`];
        environments[e] = {
          shortcode: s[`env.${e}.shortcode`],
          safaricomName: s[`env.${e}.safaricomName`],
          shortcodeKind: s[`env.${e}.shortcodeKind`] === 'till' ? 'till' : s[`env.${e}.shortcodeKind`] === 'paybill' ? 'paybill' : null,
          consumerKey: { saved: !!consumerKey, last4: consumerKey ? consumerKey.slice(-4) : null },
          consumerSecret: { saved: !!s[`env.${e}.consumerSecret`], last4: null },
          credsVerifiedAt: s[`env.${e}.credsVerifiedAt`],
          passkey: { saved: !!s[`env.${e}.passkey`], last4: null },
          passkeyProven: !!s[`env.${e}.passkeyProvenAt`],
          cert: { saved: !!s[`env.${e}.certPem`], last4: null },
          operators,
          ready: { creds, operator },
          b2cApi: {
            setting: (b2cApiSetting === 'v1' || b2cApiSetting === 'v3' ? b2cApiSetting : 'auto'),
            detected: (s[`env.${e}.b2cApiDetected`] === 'v1' || s[`env.${e}.b2cApiDetected`] === 'v3' ? (s[`env.${e}.b2cApiDetected`] as 'v1' | 'v3') : null),
            detectedAt: s[`env.${e}.b2cApiDetectedAt`],
          },
        };
      }
      return {
        mode,
        environments,
        org: { name: shared['org.name'] ?? '', nominatedNumber: shared['org.nominatedNumber'] ?? '', notificationPhone: shared['org.notificationPhone'] ?? '' },
        stkEnabled: await deps.daraja.stkEnabled(),
        publicUrl: shared['public.url'], publicVerifiedAt: shared['public.verifiedAt'], httpsSeen,
        allowlist: parseAllowlist(shared['callbacks.allowlist']),
        setupCompletedAt: shared['setup.completedAt'],
        sendCategories: parseCategories(shared['send.categories']),
        approvalThresholdCents: Number(shared['send.approvalThresholdCents'] ?? 0) || 0,
        uses: { payOut: shared['use.payOut'] === 'true', collect: shared['use.collect'] === 'true', stk: shared['use.stk'] === 'true' },
      };
    },

    async setApprovalThreshold(cents, actor) {
      await deps.settings.set('send.approvalThresholdCents', String(cents));
      await audit(deps.db, { personId: actor.personId, action: 'settings.approval_threshold', after: { cents }, ip: actor.ip });
    },
    async getSendCategories() { return parseCategories(await deps.settings.get('send.categories')); },
    async setSendCategories(items, actor) {
      const list = validateCategories(items);
      await deps.settings.set('send.categories', JSON.stringify(list));
      await audit(deps.db, { personId: actor.personId, action: 'settings.send_categories', after: list, ip: actor.ip });
      return list;
    },

    async setOrg(input, actor) {
      const name = input.name.trim(); const nominatedNumber = input.nominatedNumber.trim(); const notificationPhone = input.notificationPhone.trim();
      await deps.settings.set('org.name', name);
      await deps.settings.set('org.nominatedNumber', nominatedNumber);
      await deps.settings.set('org.notificationPhone', notificationPhone);
      // The menu header, Home and /api/auth/me read the organisation row, not the setting; the two
      // drifted apart after a wipe (the row reset to "My organisation", the setting kept the name).
      await deps.db.query(`UPDATE orgs SET name=$1 WHERE id = app_current_org()`, [name]);
      deps.daraja.invalidate();
      await audit(deps.db, { personId: actor.personId, action: 'settings.org', after: { name, nominatedNumber, notificationPhone }, ip: actor.ip });
    },

    async setShortcode(env, shortcode, actor) {
      const sc = shortcode.trim();
      // A changed number invalidates whatever confirmation and Safaricom name went with the old
      // one — cleared before the write below, not after, so a crash in between never leaves a
      // confirmed-but-changed shortcode standing (spec 4.2's guard column).
      const previous = await deps.settings.get(`env.${env}.shortcode`);
      if (previous !== sc) {
        await deps.settings.delete(`env.${env}.shortcodeConfirmedAt`);
        await deps.settings.delete(`env.${env}.safaricomName`);
      }
      try {
        await deps.settings.set(`env.${env}.shortcode`, sc);
      } catch (e) {
        // settings_prod_shortcode_uniq (migration 007): one production organisation per shortcode.
        // Sandbox shortcodes are shared by design — everybody uses 174379 — so only production can
        // land here.
        if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new HttpError(409, 'shortcode_taken', SHORTCODE_TAKEN);
        }
        throw e;
      }
      deps.daraja.invalidate();
      await audit(deps.db, { personId: actor.personId, action: 'settings.shortcode', after: { environment: env, shortcode: sc }, ip: actor.ip });

      return svc.verifyShortcode(env);
    },

    async verifyShortcode(env) {
      const sc = await deps.settings.get(`env.${env}.shortcode`);
      if (!sc) return { verifiedName: null, verifyError: 'Enter the paybill or till number first.' };
      // Verify the shortcode against Safaricom only once that environment's own creds are saved
      // and have themselves already been accepted by Safaricom — never against another
      // environment's creds, and never before Safaricom has confirmed the pair works at all.
      const slot = await deps.settings.getMany([`env.${env}.consumerKey`, `env.${env}.consumerSecret`, `env.${env}.credsVerifiedAt`, `env.${env}.passkey`]);
      const consumerKey = slot[`env.${env}.consumerKey`];
      const consumerSecret = slot[`env.${env}.consumerSecret`];
      if (!consumerKey || !consumerSecret || !slot[`env.${env}.credsVerifiedAt`]) {
        return { verifiedName: null, verifyError: null };
      }
      try {
        const client = new Daraja({
          consumerKey, consumerSecret, shortcode: sc,
          passkey: slot[`env.${env}.passkey`] || PASSKEY_NOT_SET,
          environment: env,
          maxNetworkRetries: 2,
          tokenStore: {
            get: (k) => deps.cache.get<string>(`token:${k}`),
            set: (k, v, ttl) => deps.cache.set(`token:${k}`, v, ttl),
          },
          ...(deps.fetchImpl ? { fetchImpl: f } : {}),
        });
        // A number is a paybill or a till; Safaricom only answers for the right kind, so both are
        // tried and the one that answers is remembered for the labels.
        let last: { responseMessage: string } | null = null;
        for (const kind of ['paybill', 'till'] as const) {
          const r = await client.orgInfo.query({ identifier: sc, identifierType: kind });
          if (r.success) {
            await deps.settings.set(`env.${env}.safaricomName`, r.organizationName);
            await deps.settings.set(`env.${env}.shortcodeKind`, kind);
            return { verifiedName: r.organizationName, verifyError: null };
          }
          last = r;
        }
        await deps.settings.delete(`env.${env}.safaricomName`);
        return { verifiedName: null, verifyError: last?.responseMessage || 'Safaricom answered, but gave no reason.' };
      } catch (e) {
        await deps.settings.delete(`env.${env}.safaricomName`);
        // A DarajaAPIError means Safaricom itself answered with an error envelope — that message
        // is not a raw SDK/network detail, just the one line Safaricom actually sent, and there is
        // no catalog meaning to enrich it with either: the SDK's DarajaScope has no 'orginfo'
        // member, so this call is never proven against the catalog.
        if (e instanceof DarajaAPIError) return { verifiedName: null, verifyError: e.message };
        // Never forward a raw SDK/network error message to the browser — every other
        // Safaricom-facing error in this codebase is curated for the same reason.
        return { verifiedName: null, verifyError: 'Could not verify with Safaricom.' };
      }
    },

    async setMode(env, confirmShortcode, actor) {
      if (env === 'production') {
        const s = await deps.settings.getMany(['env.production.shortcode', 'daraja.environment', 'setup.completedAt']);
        const sc = s['env.production.shortcode'];
        // The typed-back shortcode guards a live studio against an accidental move to real money.
        // It has nothing to guard while setup is still running (the wizard asks for the environment
        // before the shortcode, and Back can land here again with one stored), nor when the studio
        // is already in production and nothing changes.
        const switching = s['daraja.environment'] !== 'production';
        if (sc && s['setup.completedAt'] && switching && confirmShortcode !== sc) throw new HttpError(400, 'confirm_shortcode', 'Type your shortcode exactly to switch to production.');
      }
      await deps.settings.set('daraja.environment', env);
      deps.daraja.invalidate();
      await audit(deps.db, { personId: actor.personId, action: 'settings.mode', after: env, ip: actor.ip });
      const s = await deps.settings.getMany([`env.${env}.consumerKey`, `env.${env}.consumerSecret`, `env.${env}.credsVerifiedAt`]);
      const { creds, operator } = await envReady(env, { consumerKey: s[`env.${env}.consumerKey`], consumerSecret: s[`env.${env}.consumerSecret`], credsVerifiedAt: s[`env.${env}.credsVerifiedAt`] });
      return { mode: env, ready: { creds, operator } };
    },

    async setDarajaCreds(env, key, secret, actor) {
      const hashKey = `env.${env}.consumerKeyHash` as const;
      const previousHash = await deps.settings.get(hashKey);
      // Claim the app before Safaricom is asked to do any work: settings_consumer_key_uniq
      // (migration 008) is what makes "one organisation per Daraja app" true, for sign-up and for
      // this route alike. A duplicate is a plain-English 409 rather than a raw constraint error.
      try {
        await deps.settings.set(hashKey, sha256(key));
      } catch (e) {
        if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) {
          await audit(deps.db, { personId: actor.personId, action: 'settings.daraja_app_taken', after: { environment: env }, ip: actor.ip });
          throw new HttpError(409, 'app_taken', APP_TAKEN);
        }
        throw e;
      }
      const check = await oauthCheck(env, key, secret, f);
      if (!check.ok) {
        // A rejected retry restores whatever claim this environment already held — never releases
        // an already-verified claim to anyone else, just because a later attempt was mistyped. That
        // restore can itself lose a race: if some other organisation legitimately claimed this same
        // key while this attempt was in flight, this is not a 500 — it is the ordinary "already
        // taken" refusal, same as claiming it fresh (Minor 10, final review).
        if (previousHash) {
          try {
            await deps.settings.set(hashKey, previousHash);
          } catch (e) {
            if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) {
              // Lost the race: that key now genuinely belongs to whoever claimed it in the
              // meantime, and this organisation must not go on looking like it still holds a
              // claim either — the stale, rejected attempt's hash is released outright rather
              // than left standing. This organisation's own real key is unclaimed here until it
              // is saved again. Same response shape as a fresh claim's own conflict (above): a
              // 409, not a 200 the caller could mistake for anything short of "try again".
              await deps.settings.delete(hashKey);
              await audit(deps.db, { personId: actor.personId, action: 'settings.daraja_app_taken', after: { environment: env }, ip: actor.ip });
              throw new HttpError(409, 'app_taken', `${APP_TAKEN} Your own key is unclaimed here now — save it again to use it.`);
            }
            throw e;
          }
        } else {
          await deps.settings.delete(hashKey);
        }
        await audit(deps.db, { personId: actor.personId, action: 'settings.daraja_rejected', after: { environment: env }, ip: actor.ip });
        return { ok: false, message: check.message };
      }
      await deps.settings.set(`env.${env}.consumerKey`, key);
      await deps.settings.set(`env.${env}.consumerSecret`, secret);
      await deps.settings.set(`env.${env}.credsVerifiedAt`, new Date().toISOString());
      deps.daraja.invalidate();
      await audit(deps.db, { personId: actor.personId, action: 'settings.daraja_creds', after: { environment: env }, ip: actor.ip });
      // The shortcode is often entered before the key and secret; now that they work, fetch its name.
      const pending = await deps.settings.getMany([`env.${env}.shortcode`, `env.${env}.safaricomName`]);
      if (pending[`env.${env}.shortcode`] && !pending[`env.${env}.safaricomName`]) { try { await svc.verifyShortcode(env); } catch { /* a name is a nicety; the creds are saved */ } }
      return { ok: true, message: 'Safaricom accepted the key and secret.' };
    },

    async setPasskey(env, passkey, actor) {
      // A different passkey has not been proven by the push that proved the old one. Leaving the old
      // proof in place is how a wrong passkey saved on 17 September went on looking proven while
      // every push was refused.
      const before = await deps.settings.get(`env.${env}.passkey`);
      if (before !== passkey.trim()) await deps.settings.delete(`env.${env}.passkeyProvenAt`);
      await deps.settings.set(`env.${env}.passkey`, passkey.trim());
      deps.daraja.invalidate();
      await audit(deps.db, { personId: actor.personId, action: 'settings.passkey', after: { environment: env }, ip: actor.ip });
    },

    async setB2cApi(env, version, actor) {
      const current = (await deps.settings.get(`env.${env}.b2cApi`)) ?? 'auto';
      await deps.settings.set(`env.${env}.b2cApi`, version);
      // A changed choice invalidates whatever auto-detection found under the old choice — the
      // owner is deliberately overriding it, so a stale "Detected: v3" must not linger under v1.
      if (version !== current) {
        await deps.settings.delete(`env.${env}.b2cApiDetected`);
        await deps.settings.delete(`env.${env}.b2cApiDetectedAt`);
      }
      await audit(deps.db, { personId: actor.personId, action: 'settings.b2c_api', after: { environment: env, version }, ip: actor.ip });
    },

    async setAllowlist(list, actor) {
      if (list.length === 0) throw new HttpError(400, 'bad_allowlist', 'Keep at least one Safaricom address. To use the defaults, do not change this list.');
      await deps.settings.set('callbacks.allowlist', list.join(','));
      await audit(deps.db, { personId: actor.personId, action: 'settings.allowlist', after: list, ip: actor.ip });
    },

    async setPublicUrl(url, actor) {
      const u = new URL(url);
      if (u.username || u.password) throw new HttpError(400, 'bad_url', 'Remove the user:password part from the address.');
      if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new HttpError(400, 'https_required', 'The public address must start with https://');
      const normalised = u.origin + u.pathname.replace(/\/+$/, '');
      await deps.settings.set('public.url', normalised);
      await deps.settings.delete('public.verifiedAt');
      // Audit the normalised value we actually store, never the raw input — the raw URL may
      // carry a query string or (rejected above, but defense in depth) userinfo.
      await audit(deps.db, { personId: actor.personId, action: 'settings.public_url', after: normalised, ip: actor.ip });
    },

    async testPublicUrl() {
      const publicUrl = await deps.settings.get('public.url');
      if (!publicUrl) return { ok: false, detail: 'Enter your public address first.' };
      const nonce = randomSecret(16);
      const url = callbackUrls(publicUrl, await currentCallbackSecret(deps.orgs)).selftest;
      try {
        const r = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'manual',
        });
        if (r.status !== 200) return { ok: false, detail: `Your address answered ${r.status}. Expected 200.` };
      } catch (e) {
        return { ok: false, detail: `Could not reach ${publicUrl}: ${e instanceof Error ? e.message : 'unknown error'}` };
      }
      const ATTEMPTS = 6;
      for (let i = 0; i < ATTEMPTS; i++) {
        if (await deps.cache.get(`selftest:${nonce}`)) {
          await deps.settings.set('public.verifiedAt', new Date().toISOString());
          return { ok: true, detail: 'Safaricom will be able to reach you here.' };
        }
        // Don't sleep after the last check — there is nothing left to wait for once we're
        // about to give up.
        if (i < ATTEMPTS - 1) await sleep(500);
      }
      return { ok: false, detail: 'The address answered, but the message did not arrive at this studio. Is it pointing at a different server?' };
    },

    async revealInstallSecret(actor) {
      const secret = await currentCallbackSecret(deps.orgs);
      await audit(deps.db, { personId: actor.personId, action: 'settings.install_secret_revealed', ip: actor.ip });
      return secret;
    },
  };
  return svc;
}
