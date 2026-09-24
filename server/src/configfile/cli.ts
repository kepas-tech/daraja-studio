import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool, withOrg } from '../db/pool.js';
import { createDbKeyring } from '../crypto/secrets.js';
import { createSettings } from '../settings/store.js';
import { createOrgService } from '../orgs/service.js';
import { createModuleService } from '../modules/service.js';
import { createBusinessesService } from '../businesses/service.js';
import { createApiKeysService } from '../keys/service.js';
import { createWebhooksService } from '../webhooks/service.js';
import type { EventHub } from '../events/hub.js';
import { z } from 'zod';
import { checkConfig } from './validate.js';
import { studioConfig } from './schema.js';
import { applyPlan, describe, planConfig, type ConfigDeps, type Plan } from './plan.js';

/**
 * The configuration file's command. It runs where the studio runs, with the studio's own database
 * and secret in the environment:
 *
 *   node server/dist/configfile/cli.js check [--file studio.config.json]
 *   node server/dist/configfile/cli.js plan  [--file studio.config.json]
 *   node server/dist/configfile/cli.js apply [--file studio.config.json] [--allow-risky]
 *   node server/dist/configfile/cli.js schema      the JSON Schema, for editors
 *
 * The file defaults to STUDIO_CONFIG_FILE, then /etc/daraja-studio/studio.config.json. `check` reads
 * the file alone; `plan` also reads the studio and changes nothing; `apply` makes the plan so, and
 * prints any key or webhook secret it made, once.
 */
export interface Io { out: (line: string) => void; err: (line: string) => void }

export function printPlan(plan: Plan, io: Io): void {
  for (const p of plan.problems) io.err('problem: ' + p);
  if (!plan.changes.length) io.out('Nothing to change: the studio already matches the file.');
  for (const c of plan.changes) io.out('+ ' + describe(c));
  for (const r of plan.risky) io.out('! changes money handling: ' + r);
  for (const n of plan.notes) io.out('note: ' + n);
}

export async function main(argv: string[], io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'schema') { io.out(JSON.stringify(z.toJSONSchema(studioConfig, { io: 'input' }), null, 2)); return 0; }
  if (!command || !['check', 'plan', 'apply'].includes(command)) {
    io.err('Say check, plan, apply or schema, then optionally --file <path> and, for apply, --allow-risky.');
    return 2;
  }
  const at = rest.indexOf('--file');
  const file = at >= 0 ? rest[at + 1] : env.STUDIO_CONFIG_FILE ?? '/etc/daraja-studio/studio.config.json';
  if (!file) { io.err('The --file option needs a path.'); return 2; }
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch {
    io.err(`Cannot read ${file}.`);
    return 2;
  }
  const checked = checkConfig(text);
  if (!checked.ok) { for (const p of checked.problems) io.err('problem: ' + p); return 1; }
  if (command === 'check') { io.out(`${file} is a valid configuration file.`); return 0; }

  const config = loadConfig(env);
  const db = createPool(config.databaseUrl, { role: 'studio_app' });
  try {
    const keyring = createDbKeyring(db, config.secretKey);
    const settings = createSettings(db, keyring);
    const orgs = createOrgService({ db, keyring, master: config.secretKey });
    const host = await orgs.host();
    if (!host) { io.err('This studio has no organisation yet; finish its setup first.'); return 1; }
    if (!host.ownerId) { io.err('This studio has no owner yet; finish its setup first.'); return 1; }
    // The command publishes no live event; the shape alone is enough for the business service.
    const events = { publish: async () => {}, subscribe: () => () => {} } as unknown as EventHub;
    const deps: ConfigDeps = {
      db,
      modules: createModuleService({ db, settings }),
      businesses: createBusinessesService({ db, settings, events, egressIps: config.egressIps }),
      keys: createApiKeysService({ db }),
      webhooks: createWebhooksService({ db, keyring }),
    };
    // The record names the owner, the only person who could have asked, and says it was the file.
    const actor = { personId: host.ownerId, ip: 'config file (' + (os.userInfo().username || 'operator') + ')' };
    return await withOrg(host.id, async () => {
      const plan = await planConfig(deps, checked.config);
      printPlan(plan, io);
      if (plan.problems.length) return 1;
      if (command === 'plan' || !plan.changes.length) return 0;
      const minted = await applyPlan(deps, plan, actor, { allowRisky: rest.includes('--allow-risky') });
      io.out('Applied.');
      for (const m of minted) {
        if (m.keySecret) io.out(`app ${m.appKey}: key ${m.keyPrefix} secret, shown once: ${m.keySecret}`);
        if (m.webhookSecret) io.out(`app ${m.appKey}: webhook signing secret, shown once: ${m.webhookSecret}`);
      }
      return 0;
    });
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  } finally {
    await db.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) })
    .then((code) => { process.exitCode = code; });
}
