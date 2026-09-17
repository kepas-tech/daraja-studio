import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createAdminPool, withOrg } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { assumeAppRole } from './boot/roleCheck.js';
import { bootTenancy } from './boot/tenancy.js';
import { createDbKeyring } from './crypto/secrets.js';
import { createOrgService } from './orgs/service.js';
import { createSettings } from './settings/store.js';
import { createInstanceSettings } from './settings/instance.js';
import { createCache } from './db/cache.js';
import { createWebauthnService } from './auth/webauthn.js';
import { createEventHub } from './events/hub.js';
import { createDarajaFactory } from './sdk/client.js';
import { createOperatorService } from './operators/service.js';
import { createSettingsService } from './settings/service.js';
import { createMoneyOutService } from './money_out/service.js';
import { createCollectService } from './collect/service.js';
import { createMoneyInService } from './money_in/service.js';
import { createBulkService } from './money_out/bulk.js';
import { createInvoicesService } from './invoices/service.js';
import { createBusinessesService } from './businesses/service.js';
import { createNotificationsService } from './notifications/service.js';
import { createNotificationWriter } from './notifications/writer.js';
import { createPushService } from './push/service.js';
import { createProblemService } from './health/problems.js';
import { createScheduler } from './scheduler/loop.js';
import { ensureRecurring } from './db/jobs.js';
import { buildHandlers } from './scheduler/handlers.js';
import { seedPublicUrl } from './boot/seed.js';
import { buildApp } from './app.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  const config = loadConfig(process.env);

  // Migrations create roles, alter tables and grant privileges: they run as DATABASE_URL's own
  // user, never as the limited studio_app role the application uses.
  const admin = createAdminPool(config.databaseUrl);
  const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const applied = await migrate(admin, migrationsDir);
  if (applied.length) console.log(`migrations applied: ${applied.join(', ')}`);

  // From here on every connection the application makes is studio_app, which row-level security
  // applies to. A warning and a role-less pool rather than dying outright when the role cannot be
  // assumed at all (a managed PostgreSQL with no CREATEROLE never ran migration 007's GRANT).
  const db = await assumeAppRole(config.databaseUrl, admin);

  const adminKeyring = createDbKeyring(admin, config.secretKey);
  const boot = await bootTenancy({ db: admin, config, keyring: adminKeyring });
  // The boot pass set the fallback on the pool it was handed — the admin one — and on the process
  // value the bare currentOrgId() answers with. The fallback belongs to the Db, so the
  // application pool needs it told directly; this is the line that makes single mode behave exactly
  // as it does today for every code path that never enters a context.
  if (boot.orgId) db.setFallbackOrg(boot.orgId);
  // Nothing after boot is allowed to write across organisations, and an open privileged pool is an
  // invitation. Closing it does not take the fallback away — that now lives on `db`.
  await admin.end();
  console.log(`organisation ${boot.orgId}${boot.created ? ' (created)' : ''}`);
  console.log(`boot pass: created=${boot.created}, secrets hashed=${boot.secretsHashed}, rows re-encrypted=${boot.rowsReencrypted}, consumer keys hashed=${boot.consumerKeysHashed}`);

  const keyring = createDbKeyring(db, config.secretKey);
  const settings = createSettings(db, keyring);
  const instance = createInstanceSettings(db, config.secretKey);
  // `master` is what `orgs.create` derives a brand-new organisation's key from, before its row
  // exists — the keyring can only derive a key for an organisation it can already read.
  const orgs = createOrgService({ db, keyring, master: config.secretKey });

  if (config.publicUrl) {
    try {
      await seedPublicUrl(settings, config.publicUrl);
    } catch {
      throw new Error('STUDIO_PUBLIC_URL must be an https address');
    }
  }

  const cache = createCache(db);
  const events = createEventHub(config.databaseUrl, db);
  let fetchImpl: typeof fetch | undefined;
  if (config.fakeSafaricom) {
    const { createFakeSafaricom } = await import('./dev/fakeSafaricom.js');
    const fake = createFakeSafaricom({
      delayMs: 1500,
      post: async (path, body) => {
        await fetch(`http://127.0.0.1:${config.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      },
    });
    fetchImpl = fake.fetchImpl;
    console.log('FAKE SAFARICOM ACTIVE: every Daraja call is answered in-process; no real money moves. Settings › Daraja key test still talks to the real Safaricom.');
  }
  const daraja = createDarajaFactory({ settings, cache, db, keyring, fetchImpl });
  const operators = createOperatorService({ db, settings, keyring, daraja, events, orgs, config });
  const settingsService = createSettingsService({ db, config, settings, instance, cache, daraja, operators, orgs });
  const moneyOut = createMoneyOutService({ db, settings, cache, daraja, events, config, orgs });
  const collect = createCollectService({ db, settings, daraja, events, config, orgs });
  const moneyIn = createMoneyInService({ db, settings, daraja, events, orgs });
  const bulk = createBulkService({ db, settings, config, events, moneyOut });
  const invoices = createInvoicesService({ db, settings, daraja, events, orgs });
  // Feature 2: businesses and customers. Needs the settings store for the last business used, so the
  // pickers can default to it, and the egress IPs for the rows the unmatched fixes hand back.
  const businesses = createBusinessesService({ db, settings, events, egressIps: config.egressIps });
  // Feature 4: the inbox. The writer follows the same hub the browser follows, so a line exists
  // before any page is opened.
  const notifications = createNotificationsService({ db, events });
  // Feature 12: off unless the deployment has a VAPID key pair, and harmless either way.
  const push = createPushService({ db, vapid: config.vapid });
  console.log(`web push: ${push.configured() ? 'on' : 'off (no VAPID keys)'}`);
  const notificationWriter = createNotificationWriter({ db, events, notifications, push, egressIps: config.egressIps });
  // Brief 2, item 2: the three states Home's banner reports, read from what is already stored.
  const problems = createProblemService({ db });
  // Brief 2, item 5b: the fingerprint. Its relying party is the public address, so without one the
  // routes answer 503 and the lock screen simply keeps asking for the PIN.
  const webauthn = createWebauthnService({ db, cache, publicUrl: config.publicUrl });

  await events.start();
  notificationWriter.start();
  await ensureRecurring(db, 'money_out_sweep', 30);
  await ensureRecurring(db, 'housekeeping', 3600);
  await ensureRecurring(db, 'daily', 86400);
  await ensureRecurring(db, 'c2b_pull', 3600);
  await ensureRecurring(db, 'approvals_expire', 600);
  const scheduler = createScheduler(db, buildHandlers({ db, events, settings, moneyOut, operators, moneyIn, bulk }));
  scheduler.start();

  const app = buildApp({ config, db, keyring, orgs, settings, instance, cache, events, daraja, operators, settingsService, moneyOut, collect, moneyIn, bulk, invoices, businesses, push, problems, webauthn, fetchImpl, scheduler });
  const listenFallback = db.getFallbackOrg();
  const envLabel = listenFallback
    ? await withOrg(listenFallback, async () => (await settings.get('daraja.environment')) ?? 'sandbox')
    : null;
  const server = app.listen(config.port, () => console.log(
    `daraja-studio listening on :${config.port}${envLabel ? ` (${envLabel}` : ' ('}${config.maxSendCents !== null ? `, send cap ${config.maxSendCents} cents` : ''})`,
  ));
  server.on('error', (e) => { console.error('boot failed:', e.message); process.exit(1); });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    notificationWriter.stop();
    server.closeIdleConnections();
    // SSE clients (events/sse.ts) hold their sockets open indefinitely, so a plain close() would
    // hang until each of them disconnects — give in-flight requests up to 10s, then force the rest.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { server.closeAllConnections(); resolve(); }, SHUTDOWN_TIMEOUT_MS);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    await events.stop();
    await db.end();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((e) => { console.error('boot failed:', e instanceof Error ? e.message : e); process.exit(1); });
