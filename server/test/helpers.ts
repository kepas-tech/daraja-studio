import request from 'supertest';
import express from 'express';
import { createPool, createAdminPool, withOrg, withSystem, type Db } from '../src/db/pool.js';
import { loadConfig, type Config } from '../src/config.js';
import { createDbKeyring, encryptForOrg, sha256, type Keyring } from '../src/crypto/secrets.js';
import { createOrgService, type OrgService } from '../src/orgs/service.js';
import { createSettings, type Settings } from '../src/settings/store.js';
import { createInstanceSettings, type InstanceSettings } from '../src/settings/instance.js';
import { createCache, type Cache } from '../src/db/cache.js';
import { buildApp, type AppDeps } from '../src/app.js';
import { createEventHub } from '../src/events/hub.js';
import { createDarajaFactory } from '../src/sdk/client.js';
import { createOperatorService } from '../src/operators/service.js';
import { createSettingsService } from '../src/settings/service.js';
import { createMoneyOutService } from '../src/money_out/service.js';
import { createCollectService } from '../src/collect/service.js';
import { createMoneyInService } from '../src/money_in/service.js';
import { createBulkService } from '../src/money_out/bulk.js';
import { createInvoicesService } from '../src/invoices/service.js';
import { createBusinessesService, type Rng } from '../src/businesses/service.js';
import { createBusinessTypesService } from '../src/businesses/types.js';
import { createStatementService } from '../src/businesses/statement.js';
import { createReconcileService } from '../src/reconcile/service.js';
import { createCasesService } from '../src/cases/service.js';
import { createApiKeysService } from '../src/keys/service.js';
import { createWebhooksService } from '../src/webhooks/service.js';
import { createNameBackfill } from '../src/money_in/names.js';
import { createPushService } from '../src/push/service.js';
import { createProblemService } from '../src/health/problems.js';
import { createModuleService } from '../src/modules/service.js';
import { createSweepService } from '../src/sweep/service.js';
import { createScheduleService } from '../src/schedules/service.js';
import { createFeesService } from '../src/fees/service.js';
import { createWebauthnService, type WebauthnVerifier } from '../src/auth/webauthn.js';
import type { PushSender } from '../src/push/sender.js';
import { hashPassword } from '../src/auth/password.js';
import type { DarajaFactory } from '../src/sdk/client.js';

export const TEST_KEY = Buffer.alloc(32, 9).toString('base64');

/** Organisation #1 of the test database. Fixed so testDeps() can stay synchronous. */
export const TEST_ORG_ID = '00000000-0000-4000-8000-000000000001';

/** The callback secret of the test database's organisation #1. Matches what setup.ts hashes. */
export const TEST_SECRET = 'sekret';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';

let adminDb: Db | null = null;
/** studio_app has no TRUNCATE, and DELETE FROM audit_log is blocked by its trigger, so resets are privileged. */
function admin(): Db {
  if (!adminDb) adminDb = createAdminPool(TEST_URL);
  return adminDb;
}

/**
 * Deleting an organisation cascades into `audit_log` through its `org_id` foreign key, and the
 * `audit_log_no_update` trigger fires on a cascaded DELETE exactly as it does on a direct one — so
 * every privileged delete of an organisation runs with the trigger off, the same way migration 007
 * does for its backfill. One helper, used by both callers below. `db` must be a pool that connects
 * as the table owner (any pool that has not `SET ROLE`d into studio_app).
 */
async function withAuditTriggerOff<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
  try {
    return await fn();
  } finally {
    await db.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
  }
}

/**
 * Put organisation #1 back, whatever state the database is in. Migration tests and the boot-pass
 * test drop the whole schema and let 007 or bootTenancy create their own `org-1` under a *generated*
 * id, so `ON CONFLICT (id)` alone is not enough: `slug`, `callback_secret_hash` and the partial
 * unique index `orgs_single_host` would each raise 23505 (pre-flight M5). Reconcile on all three —
 * drop any other row wearing one of this row's unique values, then upsert on the id.
 */
export async function ensureTestOrg(db: Db = admin()) {
  await withSystem(() =>
    withAuditTriggerOff(db, async () => {
      await db.query(
        `DELETE FROM orgs WHERE id <> $1 AND (slug = 'org-1' OR is_host OR callback_secret_hash = $2)`,
        [TEST_ORG_ID, sha256(TEST_SECRET)],
      );
      await db.query(
        `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ($1, 'org-1', 'Test organisation', 'verified', true, $2, 'unset', gen_random_bytes(32))
         ON CONFLICT (id) DO UPDATE SET slug = 'org-1', name = 'Test organisation', status = 'verified',
                                        is_host = true, callback_secret_hash = EXCLUDED.callback_secret_hash`,
        [TEST_ORG_ID, sha256(TEST_SECRET)],
      );
      // Step one of the tiers-and-modules design: this test database is an install that was already
      // running the whole surface — API keys, webhooks and the payment feed are in use on it — so it
      // is on Platform, exactly as migration 042 leaves a live one. A test that wants the starting
      // tier instead deletes this row, which is what an organisation that has never chosen has.
      await db.query(
        `INSERT INTO settings(org_id, key, value) VALUES ($1, 'org.tier', 'platform')
         ON CONFLICT (org_id, key) DO UPDATE SET value = 'platform'`,
        [TEST_ORG_ID],
      );
    }),
  );
  // New in this task: the reveal path and Settings need the secret readable, not only hashed. The
  // row is written the same way migration 007 leaves one behind — 'unset' — and finished here, so
  // there is one shape of organisation #1 in the tests and in production.
  const [row] = await withSystem(() =>
    db.query<{ callback_secret_enc: string }>('SELECT callback_secret_enc FROM orgs WHERE id = $1', [TEST_ORG_ID]),
  );
  if (row?.callback_secret_enc === 'unset') {
    const keyring = createDbKeyring(db, Buffer.from(TEST_KEY, 'base64'));
    const enc = await withOrg(TEST_ORG_ID, () => encryptForOrg(keyring, TEST_SECRET));
    await withSystem(() => db.query('UPDATE orgs SET callback_secret_enc = $2 WHERE id = $1', [TEST_ORG_ID, enc]));
  }
}

/**
 * Remove a second test organisation and everything that hangs off it. Every test file that creates
 * one ends with this instead of its own `DELETE FROM orgs`, which would trip the audit trigger.
 */
export async function deleteOrg(id: string) {
  await withSystem(() =>
    withAuditTriggerOff(admin(), () => admin().query('DELETE FROM orgs WHERE id = $1', [id])),
  );
}

export function testDeps(env: Record<string, string> = {}): { config: Config; db: Db; keyring: Keyring; orgs: OrgService; settings: Settings; instance: InstanceSettings; cache: Cache } {
  const config = loadConfig({
    DATABASE_URL: TEST_URL,
    STUDIO_SECRET_KEY: TEST_KEY,
    STUDIO_TRUST_PROXY: '1',
    NODE_ENV: 'test',
    ...env,
  });
  const db = createPool(config.databaseUrl, { role: 'studio_app' });
  // Tests are single mode: code that never enters a context belongs to organisation #1.
  db.setFallbackOrg(TEST_ORG_ID);
  const keyring = createDbKeyring(db, config.secretKey);
  return {
    config, db, keyring,
    orgs: createOrgService({ db, keyring, master: config.secretKey }),
    settings: createSettings(db, keyring),
    instance: createInstanceSettings(db, config.secretKey),
    cache: createCache(db),
  };
}

export async function resetTables(db?: Db) {
  void db; // resets are privileged; the caller's pool is studio_app and cannot TRUNCATE.
  // `modules` goes with the rest: a test starts on the tier's own set, with no hand-made departure
  // left over from the test before it. `idempotency_keys` too, and for a sharper reason: a key kept
  // from the test before would answer this test's first call with that test's answer.
  await admin().query(
    `TRUNCATE org_environment_verifications, contacts, accounts, number_widths, business_types, businesses, webauthn_credentials, people, permissions, sessions, login_attempts, rate_limits, operators, requests, bulk_plans, customer_invoices, notifications, push_subscriptions, balances, callbacks_raw, jobs, cache, settings, modules, sweep_payments, sweeps, sweep_settings, idempotency_keys, pay_run_lines, pay_runs, schedule_lines, schedules, apps RESTART IDENTITY CASCADE`,
  );
  await ensureTestOrg();
}

export function makeApp(extra: { fetchImpl?: typeof fetch; daraja?: DarajaFactory; env?: Record<string, string>; pushSender?: PushSender; rng?: Rng; webauthn?: WebauthnVerifier } = {}) {
  // testDeps() already builds `orgs` (operators.test.ts/money-out.test.ts/sweep.test.ts call
  // createOperatorService/createMoneyOutService directly off it, without going through makeApp),
  // so it is reused here rather than built a second time.
  // Every test app has a public address: it is what the fingerprint ceremonies are a relying party
  // for, and /api/auth/me reports whether this install can offer one at all. A test that needs a
  // different one passes STUDIO_PUBLIC_URL in extra.env.
  const base = testDeps({ STUDIO_PUBLIC_URL: 'https://studio.test', ...extra.env });
  const events = createEventHub(base.config.databaseUrl, base.db);
  const daraja = extra.daraja ?? createDarajaFactory({ ...base, fetchImpl: extra.fetchImpl });
  const operators = createOperatorService({ ...base, daraja, events });
  const settingsService = createSettingsService({ ...base, daraja, operators, fetchImpl: extra.fetchImpl });
  const moneyOut = createMoneyOutService({ ...base, daraja, events });
  const collect = createCollectService({ ...base, daraja, events });
  const modules = createModuleService({ db: base.db, settings: base.settings });
  const moneyIn = createMoneyInService({ ...base, daraja, events, modules });
  const bulk = createBulkService({ ...base, events, moneyOut, pauseMs: 0 });
  const invoices = createInvoicesService({ ...base, daraja, events });
  // Brief 2, item 1: the mint's random draw is injected, so a test pins the number a run produces.
  const businesses = createBusinessesService({ ...base, events, egressIps: base.config.egressIps, rng: extra.rng });
  const businessTypes = createBusinessTypesService({ db: base.db });
  const statements = createStatementService({ db: base.db });
  const reconcile = createReconcileService({ db: base.db, settings: base.settings, daraja });
  const cases = createCasesService({ db: base.db });
  const apiKeys = createApiKeysService({ db: base.db });
  const webhooks = createWebhooksService({ db: base.db, keyring: base.keyring });
  const nameBackfill = createNameBackfill({ db: base.db, moneyOut });
  // A real key pair would reach a real push service, so tests always hand in a fake sender.
  const push = createPushService({ db: base.db, vapid: base.config.vapid, sender: extra.pushSender });
  const problems = createProblemService({ db: base.db });
  // Step three of nine: sweep-through, standing on the ordinary money-out send.
  const fees = createFeesService({ db: base.db });
  const sweep = createSweepService({ db: base.db, settings: base.settings, events, fees, moneyOut, modules });
  const schedules = createScheduleService({ db: base.db, events, fees, moneyOut, modules });
  // Brief 2, item 5b: the fingerprint ceremonies. Tests hand in a fake verifier, so no real
  // authenticator is ever needed; the default relying party is a made-up https host.
  const webauthn = createWebauthnService({ db: base.db, cache: base.cache, publicUrl: base.config.publicUrl, verifier: extra.webauthn });
  const deps: AppDeps = {
    ...base,
    events, daraja, operators, settingsService, moneyOut, collect, moneyIn, bulk, invoices, businesses, businessTypes, statements, reconcile, cases, apiKeys, webhooks, nameBackfill, push, problems, webauthn, modules, sweep, schedules, fetchImpl: extra.fetchImpl,
  };
  const app = buildApp(deps);
  return { app, deps, close: async () => { await base.db.end(); } };
}

/**
 * Create the limited application role if it is absent and grant it to the login user, exactly as
 * migration 007 does. Tests need it before 007 exists, and it proves the pre-created-role path.
 */
export async function ensureStudioAppRole(db: Db) {
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
      CREATE ROLE studio_app NOLOGIN NOBYPASSRLS;
    END IF;
  END $$`);
  await db.query(`GRANT studio_app TO CURRENT_USER`);
}

export async function loginAsOwner(app: ReturnType<typeof buildApp>, deps: AppDeps) {
  await resetTables(deps.db);
  await deps.db.query(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner',$1,true)`, [await hashPassword('correct horse')]);
  const r = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
  return { cookie: r.headers['set-cookie'][0] as string, csrf: r.body.csrf as string };
}

/** Put one organisation in place, with a real callback secret (hash + v2 ciphertext), privileged. */
export async function seedOrg(
  adminPool: Db,
  opts: { id: string; slug: string; secret: string; name?: string; status?: string; isHost?: boolean },
): Promise<void> {
  await withSystem(() =>
    adminPool.query(
      `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc)
       VALUES ($1,$2,$3,$4,$5,$6,'unset')
       ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug, name=EXCLUDED.name, status=EXCLUDED.status,
                                      is_host=EXCLUDED.is_host, callback_secret_hash=EXCLUDED.callback_secret_hash`,
      [opts.id, opts.slug, opts.name ?? opts.slug, opts.status ?? 'verified', opts.isHost ?? false, sha256(opts.secret)],
    ),
  );
  const keyring = createDbKeyring(adminPool, Buffer.from(TEST_KEY, 'base64'));
  const enc = await withOrg(opts.id, () => encryptForOrg(keyring, opts.secret));
  await withSystem(() => adminPool.query('UPDATE orgs SET callback_secret_enc=$2 WHERE id=$1', [opts.id, enc]));
}

/** One person inside one organisation. Returns the new person's id. */
export async function makePerson(
  db: Db,
  orgId: string,
  p: { username: string; password: string; displayName?: string; email?: string | null; isOwner?: boolean; role?: string; hostAdmin?: boolean },
): Promise<string> {
  const passwordHash = await hashPassword(p.password);
  const [row] = await withOrg(orgId, () =>
    db.query<{ id: string }>(
      `INSERT INTO people(org_id, username, display_name, password_hash, is_owner, email, role, is_host_admin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [orgId, p.username, p.displayName ?? p.username, passwordHash, p.isOwner ?? false, p.email ?? null, p.role ?? 'custom', p.hostAdmin ?? false],
    ),
  );
  return row.id;
}

/** Log in over HTTP and hand back the cookie and the CSRF token. Throws on anything but 200. */
export async function loginAs(app: express.Express, username: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const r = await request(app).post('/api/auth/login').send({ username, password });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: (r.headers['set-cookie'] as unknown as string[])[0], csrf: r.body.csrf as string };
}
