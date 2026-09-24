import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeApp, loginAsOwner } from './helpers.js';
import { checkConfig } from '../src/configfile/validate.js';
import { planConfig, applyPlan, type ConfigDeps } from '../src/configfile/plan.js';
import { main } from '../src/configfile/cli.js';
import type { StudioConfig } from '../src/configfile/schema.js';

/**
 * The configuration file: what it refuses on its own, what a plan would change against a real
 * database, that apply makes it so with keys and secrets shown once, and that a second apply finds
 * nothing to do.
 */
const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });

const file = (o: Record<string, unknown>) => JSON.stringify({ version: 1, ...o });
const problemsOf = (text: string) => { const r = checkConfig(text); return r.ok ? [] : r.problems; };

describe('a configuration file on its own', () => {
  it('accepts a plain file and fills in the defaults', () => {
    const r = checkConfig(file({ businesses: [{ code: '003', name: 'SINRO' }], apps: [{ key: 'sinro', name: 'SINRO', business: '003' }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.apps[0]).toMatchObject({ mode: 'pass_through', hub: 'kepas', status: 'active', prefixes: [], aliases: [] });
  });

  it('refuses secrets by name, by shape and inside an address', () => {
    expect(problemsOf(file({ apps: [], webhookSecret: 'x' })).join()).toMatch(/secret/);
    expect(problemsOf(file({ notes: 'studio_abcdef0123456789' })).join()).toMatch(/looks like a secret/);
    expect(problemsOf(file({ notes: 'a'.repeat(48) })).join()).toMatch(/looks like a secret/);
    expect(problemsOf(file({
      businesses: [{ code: '003', name: 'SINRO' }],
      apps: [{ key: 'sinro', name: 'SINRO', business: '003', webhook: { url: 'https://sinro.example/hook?token=abc' } }],
    })).join()).toMatch(/looks like a secret/);
  });

  it('refuses a token that is the start of another, and one claimed twice', () => {
    const clash = problemsOf(file({
      businesses: [{ code: '100', name: 'A' }, { code: '003', name: 'B' }],
      apps: [{ key: 'tumakesh', name: 'Tumakesh', business: '003', prefixes: ['1'] }],
    }));
    expect(clash.join()).toMatch(/\(1\) is the start of business 100/);
    const twice = problemsOf(file({
      businesses: [{ code: '003', name: 'A' }, { code: '004', name: 'B' }],
      apps: [
        { key: 'enabo', name: 'enabo', business: '003', prefixes: ['ENABO'] },
        { key: 'other', name: 'other', business: '004', aliases: ['ENABO'] },
      ],
    }));
    expect(twice.join()).toMatch(/both claim ENABO/);
    // Side by side without either being the start of the other is fine.
    expect(problemsOf(file({
      businesses: [{ code: '003', name: 'A' }, { code: '004', name: 'B' }],
      apps: [
        { key: 'enabo', name: 'enabo', business: '003', prefixes: ['ENABO', 'NABO'] },
        { key: 'wabi', name: 'Wabi', business: '004', prefixes: ['3'] },
      ],
    }))).toEqual([]);
  });

  it('the shipped examples are valid', async () => {
    for (const name of ['shop', 'kepas-platform']) {
      const text = await readFile(path.join(import.meta.dirname, '..', '..', 'deploy', 'config', 'examples', name + '.json'), 'utf8');
      expect(problemsOf(text)).toEqual([]);
    }
  });

  it('refuses unknown and unbuilt modules, duplicates, and lowercase prefixes', () => {
    expect(problemsOf(file({ modules: { nosuch: true } })).join()).toMatch(/no such module/);
    expect(problemsOf(file({ modules: { custody: true } })).join()).toMatch(/not built yet/);
    expect(problemsOf(file({ businesses: [{ code: '003', name: 'A' }, { code: '003', name: 'B' }] })).join()).toMatch(/listed twice/);
    expect(problemsOf(file({ businesses: [{ code: '003', name: 'A' }], apps: [{ key: 'a', name: 'A', business: '003' }] })).join()).toMatch(/key/);
    expect(problemsOf(file({ businesses: [{ code: '003', name: 'A' }], apps: [{ key: 'ab', name: 'A', business: '003', prefixes: ['enabo'] }] })).join()).toMatch(/uppercase/);
  });
});

describe('plan and apply against the studio', () => {
  let cd: ConfigDeps;
  let actor: { personId: string; ip: string };
  beforeEach(async () => {
    await loginAsOwner(app, deps);
    const [owner] = await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE is_owner`);
    actor = { personId: owner!.id, ip: 'test' };
    cd = { db: deps.db, modules: deps.modules, businesses: deps.businesses, keys: deps.apiKeys, webhooks: deps.webhooks };
  });
  const parse = (o: Record<string, unknown>): StudioConfig => { const r = checkConfig(file(o)); if (!r.ok) throw new Error(r.problems.join('; ')); return r.config; };
  const kepas = (hub = 'kepas') => parse({
    tier: 'platform',
    businesses: [{ code: '003', name: 'SINRO' }, { code: '010', name: 'enabo' }],
    apps: [
      { key: 'sinro', name: 'SINRO', business: '003', hub: 'studio', webhook: { url: 'https://sinro.example/api/payments/webhook' } },
      { key: 'enabo', name: 'enabo', business: '010', hub, prefixes: ['ENABO', 'NABO'] },
    ],
    routing: { aliases: [{ reference: 'KEPAS', business: '003' }] },
  });

  it('makes businesses with their codes, apps, keys and addresses; a second apply changes nothing', async () => {
    const plan = await planConfig(cd, kepas());
    expect(plan.problems).toEqual([]);
    expect(plan.changes.map((c) => c.kind)).toEqual(expect.arrayContaining(['business.create', 'app.create', 'app.key', 'app.webhook']));
    expect(plan.notes.join()).toMatch(/routing is kept in the file but not in force yet/);
    const minted = await applyPlan(cd, plan, actor);

    const biz = await deps.db.query<{ code: string; id: string }>(`SELECT code, id FROM businesses ORDER BY code`);
    expect(biz.map((b) => b.code)).toEqual(['003', '010']);
    const apps = await deps.db.query<{ key: string; business_id: string; prefixes: string[] }>(`SELECT key, business_id, prefixes FROM apps ORDER BY key`);
    expect(apps).toEqual([
      { key: 'enabo', business_id: biz[1]!.id, prefixes: ['ENABO', 'NABO'] },
      { key: 'sinro', business_id: biz[0]!.id, prefixes: [] },
    ]);
    const sinro = minted.find((m) => m.appKey === 'sinro')!;
    expect(sinro.keySecret).toMatch(/\S{20,}/);
    expect(sinro.webhookSecret).toBeTruthy();
    expect(minted.find((m) => m.appKey === 'enabo')!.webhookSecret).toBeUndefined();
    expect((await deps.modules.state()).tier).toBe('platform');

    // The key the file made acts for its app's business, and only that one.
    const opened = await request(app).put('/api/accounts/by-ref/user-1').set('Authorization', `Bearer ${sinro.keySecret}`).send({});
    expect(opened.status).toBe(201);
    expect(opened.body.businessId).toBe(biz[0]!.id);

    const again = await planConfig(cd, kepas());
    expect(again.changes).toEqual([]);
    expect(await applyPlan(cd, again, actor)).toEqual([]);
    expect((await deps.db.query(`SELECT 1 FROM api_keys WHERE revoked_at IS NULL`)).length).toBe(2);
  });

  it('will not move who credits an app\'s money unless told to', async () => {
    await applyPlan(cd, await planConfig(cd, kepas()), actor);
    const flip = await planConfig(cd, kepas('studio'));
    expect(flip.risky).toEqual(['app enabo: hub from kepas to studio']);
    await expect(applyPlan(cd, flip, actor)).rejects.toThrow(/--allow-risky/);
    expect((await deps.db.query<{ hub: string }>(`SELECT hub FROM apps WHERE key='enabo'`))[0]!.hub).toBe('kepas');
    await applyPlan(cd, flip, actor, { allowRisky: true });
    expect((await deps.db.query<{ hub: string }>(`SELECT hub FROM apps WHERE key='enabo'`))[0]!.hub).toBe('studio');
    expect((await deps.db.query(`SELECT 1 FROM audit_log WHERE action='app.updated'`)).length).toBe(1);
  });

  it('reads the file against businesses it does not list, and against names already taken', async () => {
    await deps.businesses.create('Old', 'other', actor, '100');
    const plan = await planConfig(cd, parse({
      businesses: [{ code: '003', name: 'Tumakesh' }],
      apps: [{ key: 'tumakesh', name: 'Tumakesh', business: '003', prefixes: ['1'] }],
    }));
    expect(plan.problems.join()).toMatch(/\(1\) is the start of business 100 \(not in the file\)/);
    await expect(applyPlan(cd, plan, actor)).rejects.toThrow(/problems/);
    const named = await planConfig(cd, parse({ businesses: [{ code: '004', name: 'old' }] }));
    expect(named.problems.join()).toMatch(/already business 100/);
  });

  it('the command checks a file without a database', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'studio-config-'));
    const good = path.join(dir, 'good.json');
    const bad = path.join(dir, 'bad.json');
    await writeFile(good, file({ businesses: [{ code: '003', name: 'SINRO' }] }));
    await writeFile(bad, file({ password: 'x' }));
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    expect(await main(['check', '--file', good], io)).toBe(0);
    expect(await main(['check', '--file', bad], io)).toBe(1);
    expect(lines.join('\n')).toMatch(/valid configuration file[\s\S]*secret/);
  });
});
