import { Daraja } from '@kepas/daraja-js';
import type { Settings, Env } from '../settings/store.js';
import type { Cache } from '../db/cache.js';
import { PASSKEY_NOT_SET } from './client.js';
import { HttpError } from '../util/errors.js';

/**
 * A Daraja client for an initiator the studio does not have on file. Owner recovery (spec 5.4) is
 * the only caller: whoever is recovering types the operator name and password, the SecurityCredential
 * is generated from them for this one call, and neither is ever stored. Every other client in the
 * product comes from `sdk/client.ts`'s factory, which is keyed by organisation and by the *stored*
 * operator — which is exactly why it cannot serve this.
 *
 * Build **and call** this inside `withOrg(orgId)`: the token store is the shared `cache`, and
 * `db/cache.ts` prefixes its keys with the organisation in scope.
 */
export async function adhocClient(
  deps: { settings: Settings; cache: Cache; fetchImpl?: typeof fetch },
  env: Env,
  initiator: string,
  securityCredential: string,
): Promise<Daraja> {
  const s = await deps.settings.getMany([
    `env.${env}.shortcode`, `env.${env}.consumerKey`, `env.${env}.consumerSecret`, `env.${env}.passkey`, `env.${env}.credsVerifiedAt`,
  ]);
  const shortcode = s[`env.${env}.shortcode`];
  const consumerKey = s[`env.${env}.consumerKey`];
  const consumerSecret = s[`env.${env}.consumerSecret`];
  if (!shortcode || !consumerKey || !consumerSecret || !s[`env.${env}.credsVerifiedAt`]) {
    throw new HttpError(409, 'not_configured', 'This organisation has no Safaricom credentials to check against.');
  }
  return new Daraja({
    consumerKey,
    consumerSecret,
    shortcode,
    // DarajaConfig requires a passkey even when STK is never used.
    passkey: s[`env.${env}.passkey`] || PASSKEY_NOT_SET,
    environment: env,
    maxNetworkRetries: 2,
    initiator,
    securityCredential,
    tokenStore: {
      get: (k) => deps.cache.get<string>(`token:${k}`),
      set: (k, v, ttl) => deps.cache.set(`token:${k}`, v, ttl),
    },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}
