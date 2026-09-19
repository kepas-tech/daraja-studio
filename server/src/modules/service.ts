import { currentOrgId, type Db } from '../db/pool.js';
import type { Settings } from '../settings/store.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';
import {
  DEFAULT_TIER, MODULES, TIERS, isTierKey, moduleDecl, permissionLabel, tierHas,
  type TierDecl, type TierKey,
} from './registry.js';

export interface Actor { personId: string; ip: string }
export interface PermissionLine { key: string; label: string }
export interface ModuleView {
  key: string; name: string; sentence: string;
  /** Whether this module is on for this organisation right now. */
  on: boolean;
  /** False for a module that is declared and not built: it is listed, and there is nothing to switch. */
  built: boolean; switchable: boolean;
  /** The owner departed from their tier on this module. */
  changed: boolean;
  permissions: PermissionLine[];
  menu: string[];
  hides: string;
  needs: { key: string; name: string; on: boolean }[];
  /** Modules that are on and stand on this one, so it cannot be switched off while they are. */
  heldBy: { key: string; name: string }[];
}
export interface TierView { key: TierKey; name: string; sentence: string; on: string[]; planned: string[] }
export interface ModuleState {
  tier: TierKey;
  /** An explicit choice was made. False means the starting tier, for an organisation that has never
   *  chosen one. */
  chosen: boolean;
  /** The tier the current set of modules equals, when it equals one. Null after a departure. */
  matches: TierKey | null;
  /** How many modules the owner has changed by hand since the tier was set. */
  departures: number;
  tiers: TierView[];
  modules: ModuleView[];
}
/** What a tier change would do, before it is made. */
export interface TierPreview {
  from: TierKey; tier: TierKey;
  changes: { key: string; name: string; from: boolean; to: boolean }[];
  on: string[]; off: string[];
}
export interface ModuleService {
  /** One place that answers what is on. The route guard, the menu builder and the read layer all
   *  come through here, so no module can be on for a page and off for its route. */
  state(): Promise<ModuleState>;
  isOn(key: string): Promise<boolean>;
  set(key: string, enabled: boolean, actor: Actor): Promise<ModuleState & { alsoOn: string[] }>;
  preview(tier: TierKey): Promise<TierPreview>;
  setTier(tier: TierKey, actor: Actor): Promise<ModuleState & { alsoOn: string[] }>;
}

const TIER_KEY = 'org.tier';

/** A route in a module that is off says why, and names the page that turns it back on. */
export function moduleOffMessage(name: string): string {
  return name + ' is switched off for this studio. Turn it on under Organisation \u203a What this studio does.';
}
export function moduleInUseMessage(name: string, holders: string[]): string {
  return name + ' cannot be switched off while ' + holders.join(' and ') + ' is on.';
}
export function notBuiltMessage(name: string): string {
  return name + ' is not built yet, so there is nothing to switch.';
}

/**
 * The modules table holds only departures from the tier: a row exists when the owner changed a
 * module by hand, and its absence means the tier decides. A switch back to the tier's own answer
 * therefore removes the row rather than writing a second one that means the same thing.
 */
export function createModuleService(deps: { db: Db; settings: Settings }): ModuleService {
  const orgId = (): string => {
    const id = currentOrgId();
    if (!id) throw new Error('no organisation in scope');
    return id;
  };

  async function readState(): Promise<ModuleState> {
    const [row] = await deps.db.query<{ value: string }>(
      'SELECT value FROM settings WHERE org_id = $1 AND key = $2', [orgId(), TIER_KEY],
    );
    const chosen = isTierKey(row?.value ?? '');
    const tier: TierKey = chosen ? (row!.value as TierKey) : DEFAULT_TIER;
    const rows = await deps.db.query<{ key: string; enabled: boolean }>(
      'SELECT key, enabled FROM modules WHERE org_id = $1', [orgId()],
    );
    const explicit = new Map(rows.map((r) => [r.key, r.enabled]));
    const onOf = (key: string, built: boolean) => built && (explicit.has(key) ? explicit.get(key)! : tierHas(tier, key));
    const on = new Map(MODULES.map((m) => [m.key, onOf(m.key, m.built)]));
    const modules: ModuleView[] = MODULES.map((m) => ({
      key: m.key, name: m.name, sentence: m.sentence,
      on: on.get(m.key) === true, built: m.built, switchable: m.built,
      changed: explicit.has(m.key) && explicit.get(m.key) !== tierHas(tier, m.key),
      permissions: m.permissions.map((p) => ({ key: p, label: permissionLabel(p) })),
      menu: m.menu, hides: m.hides,
      needs: m.needs.map((k) => ({ key: k, name: moduleDecl(k)!.name, on: on.get(k) === true })),
      heldBy: MODULES.filter((d) => d.needs.includes(m.key) && d.built && on.get(d.key) === true)
        .map((d) => ({ key: d.key, name: d.name })),
    }));
    const onKeys = modules.filter((m) => m.on).map((m) => m.key).sort().join();
    const matches = TIERS.find((t: TierDecl) => [...t.on].sort().join() === onKeys)?.key ?? null;
    return {
      tier, chosen, matches,
      departures: modules.filter((m) => m.changed).length,
      tiers: TIERS.map((t) => ({ key: t.key, name: t.name, sentence: t.sentence, on: t.on, planned: t.planned })),
      modules,
    };
  }

  /** A module and everything it stands on, in the order it has to be switched on. */
  function withNeeds(key: string, out: string[] = []): string[] {
    const decl = moduleDecl(key);
    if (!decl) return out;
    if (!out.includes(key)) out.push(key);
    for (const need of decl.needs) withNeeds(need, out);
    return out;
  }

  async function write(key: string, enabled: boolean, actor: Actor, tier: TierKey): Promise<void> {
    // Back at the tier's own answer: the row goes, so "absent means the tier decides" stays true.
    if (enabled === tierHas(tier, key)) {
      await deps.db.query('DELETE FROM modules WHERE org_id = $1 AND key = $2', [orgId(), key]);
      return;
    }
    await deps.db.query(
      `INSERT INTO modules(org_id, key, enabled, changed_at, changed_by) VALUES ($1,$2,$3,now(),$4)
       ON CONFLICT (org_id, key) DO UPDATE SET enabled=EXCLUDED.enabled, changed_at=now(), changed_by=EXCLUDED.changed_by`,
      [orgId(), key, enabled, actor.personId],
    );
  }

  return {
    state: readState,
    async isOn(key) {
      return (await readState()).modules.find((m) => m.key === key)?.on === true;
    },

    async set(key, enabled, actor) {
      const decl = moduleDecl(key);
      if (!decl) throw new HttpError(404, 'not_found', 'There is no such module.');
      if (!decl.built) throw new HttpError(409, 'not_built', notBuiltMessage(decl.name));
      const state = await readState();
      const view = state.modules.find((m) => m.key === key)!;
      if (!enabled && view.heldBy.length > 0) {
        throw new HttpError(409, 'module_in_use', moduleInUseMessage(decl.name, view.heldBy.map((h) => h.name)), {
          module: key, heldBy: view.heldBy.map((h) => h.key),
        });
      }
      // Switching one on brings on everything it stands on, and says which, so the answer names
      // every module that moved.
      const alsoOn = enabled ? withNeeds(key).filter((k) => k !== key && state.modules.find((m) => m.key === k)?.on === false) : [];
      for (const k of alsoOn) await write(k, true, actor, state.tier);
      await write(key, enabled, actor, state.tier);
      await audit(deps.db, {
        personId: actor.personId, ip: actor.ip, action: 'modules.changed', target: key,
        before: { enabled: view.on }, after: { enabled, alsoOn },
      });
      return { ...(await readState()), alsoOn };
    },

    async preview(tier) {
      const state = await readState();
      const changes = state.modules
        .filter((m) => m.built && m.on !== tierHas(tier, m.key))
        .map((m) => ({ key: m.key, name: m.name, from: m.on, to: tierHas(tier, m.key) }));
      return {
        from: state.tier, tier, changes,
        on: changes.filter((c) => c.to).map((c) => c.key),
        off: changes.filter((c) => !c.to).map((c) => c.key),
      };
    },

    async setTier(tier, actor) {
      const before = await readState();
      await deps.settings.set(TIER_KEY, tier);
      // The tier applies its set: every hand-made departure goes, which is exactly what the preview
      // listed before it was applied. Nothing else is touched — no request, no contact, no invoice.
      await deps.db.query('DELETE FROM modules WHERE org_id = $1', [orgId()]);
      await audit(deps.db, {
        personId: actor.personId, ip: actor.ip, action: 'modules.tier_set',
        before: { tier: before.tier }, after: { tier },
      });
      return { ...(await readState()), alsoOn: [] };
    },
  };
}
