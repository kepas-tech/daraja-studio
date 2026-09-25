import type { Db } from '../db/pool.js';
import { audit } from '../audit/log.js';
import { tierHas, MODULES, type TierKey } from '../modules/registry.js';
import type { ModuleService } from '../modules/service.js';
import type { BusinessesService } from '../businesses/service.js';
import type { ApiKeysService } from '../keys/service.js';
import type { WebhooksService } from '../webhooks/service.js';
import type { AppDecl, StudioConfig } from './schema.js';
import { clashes, claimsOf } from './validate.js';
import { REASON_WORDS, type ClaimReason } from '../routing/claims.js';

/**
 * What applying a configuration file would change, worked out against the studio's own rows, and
 * then the applying of it. The plan is data, so `plan` prints it and `apply` runs the same list; a
 * second apply of the same file finds nothing to do.
 *
 * Nothing here removes anything. A business, an app or a key the file no longer lists is named in
 * the plan as left alone, never deleted: taking money paths away is a person's decision on a page.
 */
export interface ConfigDeps {
  db: Db;
  modules: ModuleService;
  businesses: BusinessesService;
  keys: ApiKeysService;
  webhooks: WebhooksService;
}
export interface ConfigActor { personId: string; ip: string }

export type Change =
  | { kind: 'tier'; tier: TierKey; from: TierKey | null }
  | { kind: 'module'; key: string; on: boolean }
  | { kind: 'business.create'; code: string; name: string; type: string }
  | { kind: 'business.update'; id: string; code: string; name?: string; type?: string }
  | { kind: 'app.create'; app: AppDecl }
  | { kind: 'app.update'; id: string; app: AppDecl; fields: string[] }
  | { kind: 'app.key'; appKey: string }
  | { kind: 'app.webhook'; appKey: string; url: string }
  | { kind: 'claim.add'; token: string; claim: 'prefix' | 'alias'; appKey?: string; businessCode?: string }
  | { kind: 'claim.release'; id: string; token: string; claim: string };

export interface Plan {
  changes: Change[];
  /** Problems found against the studio's own rows. A plan with any is never applied. */
  problems: string[];
  /** Things the file says that this version keeps but does not act on yet, and rows it leaves alone. */
  notes: string[];
  /** Changes that decide who credits money or who holds it. Applied only when the operator says so. */
  risky: string[];
}

/** An app's hub decides which system credits its payments, and its mode whether money is held for its
 *  users. Changing either on a live app is a cutover, never a side effect of editing a file. */
const RISKY_FIELDS = ['hub', 'mode', 'status'];

interface BizRow { id: string; code: string; name: string; type_key: string | null; active: boolean }
interface AppRow {
  id: string; key: string; name: string; business_id: string; status: string; mode: string; hub: string;
  phone_routing: boolean; prefixes: string[]; aliases: string[];
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function planConfig(deps: ConfigDeps, config: StudioConfig): Promise<Plan> {
  const changes: Change[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const risky: string[] = [];

  // Tier and modules. The target is the tier the file names (or the one in force) with the file's
  // own departures on top; a module the file does not mention follows the tier when the file names
  // one, and is left as it is when it does not.
  const state = await deps.modules.state();
  const tier = (config.tier as TierKey | undefined) ?? state.tier;
  const tierChanges = config.tier !== undefined && (!state.chosen || state.tier !== tier);
  if (tierChanges) changes.push({ kind: 'tier', tier, from: state.chosen ? state.tier : null });
  for (const m of MODULES) {
    if (!m.built) continue;
    const listed = config.modules[m.key];
    if (listed === undefined && config.tier === undefined) continue;
    const want = listed ?? tierHas(tier, m.key);
    // After a tier change every hand-made departure is gone, so the module stands where the tier puts it.
    const now = tierChanges ? tierHas(tier, m.key) : state.modules.find((v) => v.key === m.key)?.on === true;
    if (want !== now) changes.push({ kind: 'module', key: m.key, on: want });
  }

  // Businesses, by code.
  const businesses = await deps.db.query<BizRow>(`SELECT id, code, name, type_key, active FROM businesses`);
  const byCode = new Map(businesses.map((b) => [b.code, b]));
  for (const b of config.businesses) {
    const row = byCode.get(b.code);
    if (!row) {
      const named = businesses.find((x) => x.name.toLowerCase() === b.name.toLowerCase());
      if (named) problems.push(`business ${b.code}: the name "${b.name}" is already business ${named.code}'s.`);
      else changes.push({ kind: 'business.create', code: b.code, name: b.name, type: b.type });
      continue;
    }
    const name = row.name !== b.name ? b.name : undefined;
    const type = (row.type_key ?? 'other') !== b.type ? b.type : undefined;
    if (name !== undefined || type !== undefined) changes.push({ kind: 'business.update', id: row.id, code: b.code, name, type });
  }
  const declared = new Set(config.businesses.map((b) => b.code));
  const unlisted = businesses.filter((b) => !declared.has(b.code)).map((b) => b.code);
  if (config.businesses.length && unlisted.length) notes.push(`Businesses ${unlisted.join(', ')} are not in the file; they are left as they are.`);

  // Every code on the paybill, listed or not, is read against the app prefixes and aliases.
  const claims = [
    ...claimsOf(config),
    ...unlisted.map((code) => ({ token: code, what: `business ${code} (not in the file)`, leads: true })),
  ];
  problems.push(...clashes(claims).filter((p) => p.includes('(not in the file)')));

  // Apps, by key.
  const apps = await deps.db.query<AppRow>(`SELECT id, key, name, business_id, status, mode, hub, phone_routing, prefixes, aliases FROM apps`);
  const appByKey = new Map(apps.map((a) => [a.key, a]));
  const keys = (await deps.keys.list()).filter((k) => !k.revokedAt);
  const appKeyIds = new Map((await deps.db.query<{ id: string; app_id: string }>(
    `SELECT id, app_id FROM api_keys WHERE app_id IS NOT NULL AND revoked_at IS NULL ORDER BY created_at`)).map((r) => [r.app_id, r.id]));
  const held = await deps.webhooks.heldByKeys();
  for (const a of config.apps) {
    const biz = byCode.get(a.business);
    if (!biz && !declared.has(a.business)) { problems.push(`app ${a.key}: there is no business ${a.business}.`); continue; }
    const row = appByKey.get(a.key);
    if (!row) {
      const taken = biz && apps.find((x) => x.business_id === biz.id);
      if (taken) { problems.push(`app ${a.key}: business ${a.business} already belongs to app ${taken.key}.`); continue; }
      changes.push({ kind: 'app.create', app: a });
      changes.push({ kind: 'app.key', appKey: a.key });
      if (a.webhook) changes.push({ kind: 'app.webhook', appKey: a.key, url: a.webhook.url });
      continue;
    }
    const fields: string[] = [];
    if (row.name !== a.name) fields.push('name');
    if (!biz || row.business_id !== biz.id) fields.push('business');
    if (row.status !== a.status) fields.push('status');
    if (row.mode !== a.mode) fields.push('mode');
    if (row.hub !== a.hub) fields.push('hub');
    if (row.phone_routing !== a.phoneRouting) fields.push('phoneRouting');
    if (!same(row.prefixes, a.prefixes)) fields.push('prefixes');
    if (!same(row.aliases, a.aliases)) fields.push('aliases');
    if (fields.includes('business')) problems.push(`app ${a.key}: moving an app to another business is not done from the file; its payments already name the old one.`);
    else if (fields.length) {
      changes.push({ kind: 'app.update', id: row.id, app: a, fields });
      for (const f of fields.filter((x) => RISKY_FIELDS.includes(x))) {
        risky.push(`app ${a.key}: ${f} from ${String(row[f as 'hub' | 'mode' | 'status'])} to ${String(a[f as 'hub' | 'mode' | 'status'])}`);
      }
    }
    const keyId = appKeyIds.get(row.id);
    if (!keyId) {
      changes.push({ kind: 'app.key', appKey: a.key });
      if (a.webhook) changes.push({ kind: 'app.webhook', appKey: a.key, url: a.webhook.url });
    } else if (a.webhook && held.get(keyId)?.url !== a.webhook.url) {
      changes.push({ kind: 'app.webhook', appKey: a.key, url: a.webhook.url });
    }
  }
  const listedApps = new Set(config.apps.map((a) => a.key));
  // Route claims (migration 052): the prefixes and aliases the file declares, as rows the database
  // rule reads. Only claims of apps the file lists, and routing aliases when the file has a routing
  // part, are released; everything else is left alone. Moving or dropping a word that routes money
  // is a risky change.
  const appKeyById = new Map(apps.map((a) => [a.id, a.key]));
  const codeById = new Map(businesses.map((b) => [b.id, b.code]));
  const live = await deps.db.query<{ id: string; token: string; kind: 'prefix' | 'alias'; app_id: string | null; business_id: string | null }>(
    `SELECT id, token, kind, app_id, business_id FROM route_claims WHERE released_at IS NULL AND kind IN ('prefix', 'alias')`);
  type Want = { token: string; claim: 'prefix' | 'alias'; appKey?: string; businessCode?: string };
  const wanted: Want[] = [
    ...config.apps.flatMap((a) => [
      ...a.prefixes.map((t) => ({ token: t, claim: 'prefix' as const, appKey: a.key })),
      ...a.aliases.map((t) => ({ token: t, claim: 'alias' as const, appKey: a.key })),
    ]),
    ...(config.routing?.aliases ?? []).map((r) => (r.app ? { token: r.reference, claim: 'alias' as const, appKey: r.app } : { token: r.reference, claim: 'alias' as const, businessCode: r.business })),
  ];
  const sameTarget = (l: (typeof live)[number], w: Want) => l.kind === w.claim
    && (w.appKey ? appKeyById.get(l.app_id ?? '') === w.appKey : codeById.get(l.business_id ?? '') === w.businessCode && !l.app_id);
  const managed = (l: (typeof live)[number]) => (l.app_id ? listedApps.has(appKeyById.get(l.app_id) ?? '') : config.routing !== undefined);
  const releases = live.filter((l) => managed(l) && !wanted.some((w) => w.token === l.token && sameTarget(l, w)));
  const adds = wanted.filter((w) => !live.some((l) => l.token === w.token && sameTarget(l, w)));
  for (const l of releases) {
    changes.push({ kind: 'claim.release', id: l.id, token: l.token, claim: l.kind });
    risky.push(`${l.kind} ${l.token} stops routing to ${l.app_id ? 'app ' + appKeyById.get(l.app_id) : 'business ' + codeById.get(l.business_id ?? '')}`);
  }
  for (const w of adds) changes.push({ kind: 'claim.add', ...w });
  // What the database will say about the new words, asked with the released ones already gone, and
  // then undone: a plan changes nothing.
  if (adds.length) {
    const ROLLBACK = new Error('plan only');
    try {
      await deps.db.tx(async (c) => {
        if (releases.length) await c.query(`UPDATE route_claims SET released_at = now() WHERE id = ANY($1::uuid[])`, [releases.map((l) => l.id)]);
        for (const w of adds) {
          const [r] = (await c.query<{ why: string | null }>(`SELECT route_claim_conflict(app_current_org(), $1, $2) AS why`, [w.token, w.claim])).rows;
          if (r?.why) problems.push(`${w.claim} ${w.token}: ${REASON_WORDS[r.why as ClaimReason] ?? r.why}`);
        }
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
  }

  const strayApps = apps.filter((a) => !listedApps.has(a.key)).map((a) => a.key);
  if (strayApps.length) notes.push(`Apps ${strayApps.join(', ')} are not in the file; they are left as they are.`);
  if (keys.some((k) => k.role === 'collector' && !k.businessId)) notes.push('Some collector keys act for no business; their payments name no app.');

  // What the format carries that this version does not act on yet.
  if (config.routing) notes.push('Routing aliases are in force: a payment whose whole reference is an alias goes to its business or app. Identifier rescue and phone routing are kept in the file but not in force yet.');
  if (config.fees) notes.push('fees are kept in the file but not in force yet: no fee is charged by the file.');
  if (config.custody) notes.push('custody is kept in the file but not in force yet: no money is held per user.');
  if (config.apps.some((a) => a.prefixes.length)) notes.push('App prefixes are claimed, so no name or business code can take them; payments are routed by them from the next routing step on.');

  return { changes, problems, notes, risky };
}

/** One line per change, the way the operator reads it. */
export function describe(c: Change): string {
  switch (c.kind) {
    case 'tier': return `set the tier to ${c.tier}${c.from ? ` (now ${c.from})` : ''}`;
    case 'module': return `turn ${c.key} ${c.on ? 'on' : 'off'}`;
    case 'business.create': return `add business ${c.code} "${c.name}" (${c.type})`;
    case 'business.update': return `change business ${c.code}:${c.name !== undefined ? ` name to "${c.name}"` : ''}${c.type !== undefined ? ` kind to ${c.type}` : ''}`;
    case 'app.create': return `add app ${c.app.key} "${c.app.name}" for business ${c.app.business} (${c.app.mode}, hub ${c.app.hub})`;
    case 'app.update': return `change app ${c.app.key}: ${c.fields.join(', ')}`;
    case 'app.key': return `make a key for app ${c.appKey} (the secret is shown once)`;
    case 'app.webhook': return `point app ${c.appKey}'s notices at ${c.url}`;
    case 'claim.add': return `claim ${c.claim} ${c.token} for ${c.appKey ? 'app ' + c.appKey : 'business ' + c.businessCode}`;
    case 'claim.release': return `release ${c.claim} ${c.token}`;
  }
}

export interface Minted { appKey: string; keyPrefix?: string; keySecret?: string; webhookSecret?: string }

/**
 * Apply a plan made a moment ago. Each change is its own step, audited as the configuration file's
 * doing; a step that fails stops the rest, and running apply again picks up where it stopped, because
 * the plan is worked out afresh from the rows each time.
 */
export async function applyPlan(deps: ConfigDeps, plan: Plan, actor: ConfigActor, opts: { allowRisky?: boolean } = {}): Promise<Minted[]> {
  if (plan.problems.length) throw new Error('The plan has problems; nothing was applied.');
  if (plan.risky.length && !opts.allowRisky) throw new Error('The plan changes who credits or holds money (' + plan.risky.join('; ') + '). Nothing was applied; run it again with --allow-risky when that is meant.');
  const minted = new Map<string, Minted>();
  const mint = (k: string) => minted.get(k) ?? minted.set(k, { appKey: k }).get(k)!;
  const bizId = async (code: string) =>
    (await deps.db.query<{ id: string }>(`SELECT id FROM businesses WHERE code=$1`, [code]))[0]!.id;
  const appRow = async (key: string) =>
    (await deps.db.query<{ id: string; business_id: string; name: string }>(`SELECT id, business_id, name FROM apps WHERE key=$1`, [key]))[0]!;

  for (const c of plan.changes) {
    switch (c.kind) {
      case 'tier': await deps.modules.setTier(c.tier, actor); break;
      case 'module': await deps.modules.set(c.key, c.on, actor); break;
      case 'business.create': await deps.businesses.create(c.name, c.type, actor, c.code); break;
      case 'business.update': {
        const [row] = await deps.db.query<{ name: string; active: boolean }>(`SELECT name, active FROM businesses WHERE id=$1`, [c.id]);
        if (c.name !== undefined) await deps.businesses.update(c.id, c.name, row!.active, actor);
        if (c.type !== undefined) await deps.businesses.updateType(c.id, c.type, actor);
        break;
      }
      case 'app.create': {
        const a = c.app;
        const [row] = await deps.db.query<{ id: string }>(
          `INSERT INTO apps(key, name, business_id, status, mode, hub, phone_routing, prefixes, aliases)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [a.key, a.name, await bizId(a.business), a.status, a.mode, a.hub, a.phoneRouting, a.prefixes, a.aliases]);
        await audit(deps.db, { personId: actor.personId, ip: actor.ip, action: 'app.created', target: row!.id, after: { ...a, webhook: undefined, by: 'configuration file' } });
        break;
      }
      case 'app.update': {
        const a = c.app;
        const [before] = await deps.db.query<AppRow>(`SELECT * FROM apps WHERE id=$1`, [c.id]);
        await deps.db.query(
          `UPDATE apps SET name=$2, status=$3, mode=$4, hub=$5, phone_routing=$6, prefixes=$7, aliases=$8, updated_at=now() WHERE id=$1`,
          [c.id, a.name, a.status, a.mode, a.hub, a.phoneRouting, a.prefixes, a.aliases]);
        await audit(deps.db, {
          personId: actor.personId, ip: actor.ip, action: 'app.updated', target: c.id,
          before: { name: before!.name, status: before!.status, mode: before!.mode, hub: before!.hub, phoneRouting: before!.phone_routing, prefixes: before!.prefixes, aliases: before!.aliases },
          after: { name: a.name, status: a.status, mode: a.mode, hub: a.hub, phoneRouting: a.phoneRouting, prefixes: a.prefixes, aliases: a.aliases, by: 'configuration file' },
        });
        break;
      }
      case 'app.key': {
        const app = await appRow(c.appKey);
        const made = await deps.keys.create({ name: `${app.name} app`, role: 'collector', businessId: app.business_id }, actor);
        await deps.db.query(`UPDATE api_keys SET app_id=$2 WHERE id=$1`, [made.key.id, app.id]);
        await audit(deps.db, { personId: actor.personId, ip: actor.ip, action: 'app.key_made', target: app.id, after: { prefix: made.key.prefix, by: 'configuration file' } });
        Object.assign(mint(c.appKey), { keyPrefix: made.key.prefix, keySecret: made.secret });
        break;
      }
      case 'app.webhook': {
        const app = await appRow(c.appKey);
        const [key] = await deps.db.query<{ id: string }>(
          `SELECT id FROM api_keys WHERE app_id=$1 AND revoked_at IS NULL ORDER BY created_at LIMIT 1`, [app.id]);
        const saved = await deps.webhooks.forKey(key!.id).save(c.url, actor);
        if (saved.secret) mint(c.appKey).webhookSecret = saved.secret;
        break;
      }
      case 'claim.release': {
        await deps.db.query(`UPDATE route_claims SET released_at = now() WHERE id = $1 AND released_at IS NULL`, [c.id]);
        await audit(deps.db, { personId: actor.personId, ip: actor.ip, action: 'route_claim.released', target: c.id, before: { token: c.token, kind: c.claim }, after: { by: 'configuration file' } });
        break;
      }
      case 'claim.add': {
        const appId = c.appKey ? (await appRow(c.appKey)).id : null;
        const businessId = c.businessCode ? await bizId(c.businessCode) : null;
        const [row] = await deps.db.query<{ id: string }>(
          `INSERT INTO route_claims(token, kind, app_id, business_id) VALUES ($1, $2, $3, $4) RETURNING id`, [c.token, c.claim, appId, businessId]);
        await audit(deps.db, { personId: actor.personId, ip: actor.ip, action: 'route_claim.added', target: row!.id, after: { token: c.token, kind: c.claim, app: c.appKey ?? null, business: c.businessCode ?? null, by: 'configuration file' } });
        break;
      }
    }
  }
  return [...minted.values()];
}
