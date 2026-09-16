import { classify, type DarajaScope } from '@kepas/daraja-js';
export type { DarajaScope };

// Keyed by `${scope}:${code}` — the same numeric code means different things on different
// endpoints (e.g. resultCode 1 is the customer's balance for `stk`/`b2c` but the platform's own
// Working-account balance for `b2b`; 2001 is a wrong PIN on `ratiba`/`bonga` but a bad initiator
// credential on `b2c`/`b2b`). Only pairs present in the SDK's CATALOG as of @kepas/daraja-js 1.5.0
// are listed here — everything else falls through to the generic message below rather than guessing.
const WHAT_TO_DO: Record<string, string> = {
  'stk:1': 'The customer does not have enough M-Pesa balance. Ask them to top up, then send the request again.',
  'stk:1037': 'The customer did not answer the prompt. Ask them to keep the phone unlocked and try again.',
  'stk:1032': 'The customer cancelled the prompt. Nothing was charged.',
  'b2c:1': 'Your Utility account float is too low. Move float from Working to Utility (or top up), then send again.',
  'b2b:1': 'The Working account does not have enough funds. Fund it, then try again.',
  'b2b:21': 'Safaricom says this operator is not allowed to do this. Check its roles in the Safaricom portal.',
  'b2c:2001': 'Safaricom rejected the API operator credential. In Settings, give this operator a new password or Security Credential (from the Safaricom portal), then send again.',
  'b2c:8006': 'This API operator\'s Security Credential is locked. Reset the operator password on the M-Pesa org portal, then set the new credential in Settings.',
  'b2b:2001': 'Safaricom rejected the API operator credential. In Settings, give this operator a new password or Security Credential (from the Safaricom portal), then try again.',
  'status:25': 'Safaricom could not read the query. Check the receipt and try again; if it keeps happening, contact Safaricom API support with the text above.',
  'b2c:403.002.1001': 'On the Daraja portal, open the app whose key you saved and check that the B2C API is on it. If it is not, ask Safaricom API support to enable B2C for this shortcode, then try again.',
  'balance:2001': 'On the M-Pesa business portal (Search › Organization Operator › your number › Detail on this user) the user must show Active, not Pending Active: a Business Manager presses Set Password there. It must hold the roles Balance Query ORG API and ORG B2C API initiator. Then add it here again with that password and the certificate for this environment (or a fresh Security Credential from the Daraja portal › Test Credentials).',
  // A v3 send only: the app itself is not subscribed to the B2C v3 gateway product (a separate
  // subscription from plain B2C). The general pair above stays for a v1 send with this same code.
  'b2c:403.002.1001:v3': "In Settings, under this environment's Daraja app, set the B2C API version to v1 and send again. Nothing was sent.",
};

// Pairs the SDK's own CATALOG has no entry for at all (so `classify()` never sets a meaning),
// observed live rather than documented — kept tiny and only for codes with a WHAT_TO_DO entry
// above, so the two always ship together.
const MEANING_FALLBACK: Record<string, string> = {
  'b2c:403.002.1001': 'This Daraja app is not allowed to use Business to Customer (B2C) payments in this environment. Balance and lookups can still work while this is the case.',
  'balance:2001': "Safaricom does not recognise this API operator's name or password for this shortcode.",
  // See the matching WHAT_TO_DO override above: a v3 send only, where the app is not subscribed
  // to the v3 gateway product specifically (v1 may still work fine).
  'b2c:403.002.1001:v3': "Safaricom's gateway did not allow this app to use the B2C v3 endpoint.",
  // The same Safaricom refusal on the read-only APIs. Neither pair is in the SDK's CATALOG, so
  // without these `explain` would fall through to "Safaricom did not explain this code". Unlike
  // the b2c entry above, Safaricom does not tell us which of the two causes it is here — observed
  // live rather than documented — so this is a hedged observation, not a claimed cause.
  'balance:403.002.1001': "Safaricom's gateway refused this request for this shortcode. On a hosted service the usual cause is an address Safaricom has not whitelisted yet; it can also mean this API is not enabled on the app.",
  'status:403.002.1001': "Safaricom's gateway refused this request for this shortcode. On a hosted service the usual cause is an address Safaricom has not whitelisted yet; it can also mean this API is not enabled on the app.",
};

export interface Explanation {
  safaricomSaid: string;
  meaning: string;
  whatToDo: string;
  retriable: boolean;
  catalogued: boolean;
}

/**
 * The one code that means "Safaricom does not accept requests for this shortcode from where this
 * service lives" (spec 4.6). Only a hosted studio can say which address to whitelist — a
 * self-hoster's server is their own — so this copy appears only when `opts.egressIps` is non-empty.
 */
const WHITELIST_CODE = '403.002.1001';
const WHITELIST_SCOPES = new Set<DarajaScope>(['b2c', 'balance', 'status']);

// "a and b" for two addresses, "a, b and c" for three or more — the way a person reads a list
// aloud, not a bare comma-join.
function listAddresses(ips: string[]): string {
  if (ips.length <= 2) return ips.join(' and ');
  return `${ips.slice(0, -1).join(', ')} and ${ips[ips.length - 1]}`;
}

export function whitelistAdvice(ips: string[]): string {
  return `Safaricom refused because this service's address is not on your whitelist. Ask Safaricom to whitelist ${listAddresses(ips)} for your shortcode, then try again. If it already is, check on the Daraja portal that the B2C API is on this app.`;
}

/** `opts.b2cApiUsed` distinguishes the v3-specific 403.002.1001 copy (points at the Settings B2C
 * API version) from the general one shown for a v1 send with the same code. `opts.egressIps` is the
 * hosted service's own outgoing addresses; when they are given, 403.002.1001 on `b2c`, `balance` or
 * `status` becomes the whitelist instruction instead (spec 4.6). Omit both for every other call —
 * the general/cataloged text is unaffected. */
export function explain(
  scope: DarajaScope,
  code: string | number,
  resultDesc: string,
  opts?: { b2cApiUsed?: 'v1' | 'v3'; egressIps?: string[] },
): Explanation {
  const c = classify(scope, code, resultDesc);
  const catalogued = c.catalogued;
  const key = `${scope}:${code}`;
  const versionedKey = opts?.b2cApiUsed === 'v3' ? `${key}:v3` : null;
  const egressIps = opts?.egressIps ?? [];
  // A hosted organisation must be told the address before anything else: on a hosted service the
  // whitelist is the usual cause of this code, and the tenant cannot guess the address.
  // Note: `meaning` and `whatToDo` can disagree in one case by design — a v3 send with `egressIps`
  // set keeps the v3-specific meaning below (the SDK still saw a v3 rejection) but shows the
  // whitelist `whatToDo`, because whitelisting is the likelier cause on a hosted service.
  const whitelisted = egressIps.length > 0 && String(code) === WHITELIST_CODE && WHITELIST_SCOPES.has(scope);
  return {
    safaricomSaid: resultDesc,
    meaning: (versionedKey && MEANING_FALLBACK[versionedKey]) ?? (catalogued && c.meaning ? c.meaning : (MEANING_FALLBACK[key] ?? 'Safaricom did not explain this code. The exact text is above.')),
    whatToDo: whitelisted
      ? whitelistAdvice(egressIps)
      : (versionedKey && WHAT_TO_DO[versionedKey]) ?? WHAT_TO_DO[key] ?? (catalogued && c.retriable ? 'You can try again.' : 'If this keeps happening, contact Safaricom API support with the text above.'),
    retriable: catalogued ? !!c.retriable : false,
    catalogued,
  };
}
