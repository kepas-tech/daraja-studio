import { moduleDecl } from '../modules/registry.js';
import { studioConfig, type StudioConfig } from './schema.js';

/**
 * Read a configuration file's text into a checked configuration, or into the list of what is wrong
 * with it, each problem named by where it sits in the file. Nothing here touches the database: these
 * are the rules a file breaks on its own. The rules that need the studio's own rows (a code already
 * taken, a prefix that clashes with a business the file does not list) are checked by the plan.
 */
export type Checked = { ok: true; config: StudioConfig } | { ok: false; problems: string[] };

/** Names a secret goes under. A file that carries one is refused whole, before anything is read. */
const SECRET_NAMES = /secret|password|passkey|passwd|token|apikey|api_key|private|credential/i;
/** Values that look like one: a Studio key, a kepas-pay key, a long run of hex or base64, a PEM block. */
const SECRET_VALUES = [
  /^studio_[A-Za-z0-9_-]{8,}/,
  /^kpk_[A-Za-z0-9_-]{8,}/,
  /^(sk|pk|rk)_(live|test)_/,
  /^[0-9a-f]{32,}$/i,
  /^[A-Za-z0-9+/_-]{40,}={0,2}$/,
  /-----BEGIN [A-Z ]+-----/,
];
/** A URL may carry a secret in its user part or its query string. */
const SECRET_IN_URL = /\/\/[^/@\s]+:[^/@\s]+@|[?&](key|secret|token|signature|sig|password)=/i;

function secretsIn(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (SECRET_VALUES.some((r) => r.test(value.trim())) || SECRET_IN_URL.test(value)) {
      out.push(`${path}: this looks like a secret. Secrets never go in the file; apply makes them and shows them once.`);
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => secretsIn(v, `${path}[${i}]`, out)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const at = path ? `${path}.${k}` : k;
      if (k !== '$schema' && SECRET_NAMES.test(k)) {
        out.push(`${at}: a field by this name would hold a secret. Secrets never go in the file.`);
        continue;
      }
      secretsIn(v, at, out);
    }
  }
}

/**
 * Every reference token the file claims on the paybill: business codes, app prefixes and aliases.
 * A payment's account reference is read against all of them at once, so no one of them may be the
 * start of another, or one reference could mean two things.
 */
export interface Claim { token: string; what: string }

export function clashes(claims: Claim[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < claims.length; i++) {
    for (let j = 0; j < claims.length; j++) {
      if (i === j) continue;
      const a = claims[i]!; const b = claims[j]!;
      if (a.token === b.token) {
        if (i < j) out.push(`${a.what} and ${b.what} both claim ${a.token}.`);
      } else if (b.token.startsWith(a.token)) {
        out.push(`${a.what} (${a.token}) is the start of ${b.what} (${b.token}), so a payment to ${b.token} could be read as either.`);
      }
    }
  }
  return out;
}

/** The claims the file itself makes. */
export function claimsOf(config: StudioConfig): Claim[] {
  return [
    ...config.businesses.map((b) => ({ token: b.code, what: `business ${b.code}` })),
    ...config.apps.flatMap((a) => [
      ...a.prefixes.map((p) => ({ token: p, what: `app ${a.key}'s prefix` })),
      ...a.aliases.map((t) => ({ token: t, what: `app ${a.key}'s alias` })),
    ]),
    ...(config.routing?.aliases ?? []).map((r) => ({ token: r.reference, what: 'routing alias' })),
  ];
}

export function checkConfig(text: string): Checked {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    return { ok: false, problems: ['The file is not valid JSON: ' + (e as Error).message] };
  }
  const secrets: string[] = [];
  secretsIn(raw, '', secrets);
  if (secrets.length) return { ok: false, problems: secrets };

  const parsed = studioConfig.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(top)'}: ${i.message}`) };
  }
  const config = parsed.data;
  const problems: string[] = [];

  const dup = <T>(items: T[], by: (t: T) => string, say: (k: string) => string) => {
    const seen = new Set<string>();
    for (const it of items) {
      const k = by(it);
      if (seen.has(k)) problems.push(say(k));
      seen.add(k);
    }
  };
  dup(config.businesses, (b) => b.code, (k) => `businesses: code ${k} is listed twice.`);
  dup(config.businesses, (b) => b.name.toLowerCase(), (k) => `businesses: the name "${k}" is listed twice.`);
  dup(config.apps, (a) => a.key, (k) => `apps: ${k} is listed twice.`);
  dup(config.apps, (a) => a.business, (k) => `apps: business ${k} has two apps; a business has one app.`);

  for (const [key] of Object.entries(config.modules)) {
    const decl = moduleDecl(key);
    if (!decl) problems.push(`modules.${key}: there is no such module.`);
    else if (!decl.built) problems.push(`modules.${key}: ${decl.name} is not built yet, so there is nothing to switch.`);
  }
  const policies = Object.keys(config.fees?.policies ?? {});
  for (const a of config.apps) {
    if (a.feePolicy && !policies.includes(a.feePolicy)) problems.push(`apps.${a.key}.feePolicy: there is no fee policy called ${a.feePolicy}.`);
    if (a.phoneRouting && a.prefixes.length === 0) problems.push(`apps.${a.key}: phone routing reads a phone after the app's prefix, and the app has none.`);
  }
  const appKeys = new Set(config.apps.map((a) => a.key));
  for (const r of config.routing?.aliases ?? []) {
    if (!r.business === !r.app) problems.push(`routing.aliases ${r.reference}: name either a business or an app, not both or neither.`);
    if (r.app && !appKeys.has(r.app)) problems.push(`routing.aliases ${r.reference}: there is no app called ${r.app}.`);
  }
  problems.push(...clashes(claimsOf(config)));
  return problems.length ? { ok: false, problems } : { ok: true, config };
}
