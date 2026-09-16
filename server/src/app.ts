import express, { type Request } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { Keyring } from './crypto/secrets.js';
import type { OrgService } from './orgs/service.js';
import type { Settings } from './settings/store.js';
import type { InstanceSettings } from './settings/instance.js';
import type { Cache } from './db/cache.js';
import type { EventHub } from './events/hub.js';
import type { DarajaFactory } from './sdk/client.js';
import type { OperatorService } from './operators/service.js';
import type { SettingsService } from './settings/service.js';
import type { MoneyOutService } from './money_out/service.js';
import { stkHandler } from './callbacks/stk.js';
import { errorMiddleware, notFound } from './util/errors.js';
import { orgContext } from './http/orgContext.js';
import { requireOrgActive } from './http/orgActive.js';
import { authRoutes } from './auth/routes.js';
import { requirePasswordChanged } from './auth/middleware.js';
import { callbackRoutes, callbackErrorHandler } from './callbacks/router.js';
import { selftestHandler } from './callbacks/selftest.js';
import { balanceHandler } from './callbacks/balance.js';
import { b2cHandler } from './callbacks/b2c.js';
import { b2cTimeoutHandler } from './callbacks/b2cTimeout.js';
import { statusHandler } from './callbacks/status.js';
import { reversalHandler, reversalTimeoutHandler } from './callbacks/reversal.js';
import { sseRoute } from './events/sse.js';
import { settingsRoutes } from './settings/routes.js';
import { peopleRoutes } from './people/routes.js';
import { setupRoutes } from './setup/routes.js';
import { healthRoutes } from './health/routes.js';
import { sendRoutes, requestRoutes, balanceRoutes, lookupRoutes, waitingRoutes } from './money_out/routes.js';
import { reversalRoutes } from './money_out/reversal.js';
import { qrRoutes } from './qr/routes.js';
import { orgRoutes } from './orgs/routes.js';
import { collectRoutes } from './collect/routes.js';
import type { CollectService } from './collect/service.js';
import { moneyInRoutes } from './money_in/routes.js';
import { approvalRoutes, bulkRoutes } from './money_out/routes.js';
import type { BulkService } from './money_out/bulk.js';
import type { MoneyInService } from './money_in/service.js';
import { c2bConfirmHandler, c2bValidateHandler } from './callbacks/c2b.js';
import { billManagerHandler } from './callbacks/billmanager.js';
import { expressHandler, ratibaHandler } from './callbacks/collectKinds.js';
import { invoiceRoutes } from './invoices/routes.js';
import { contactsRoutes } from './contacts/routes.js';
import { businessesRoutes, customersRoutes } from './businesses/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import type { BusinessesService } from './businesses/service.js';
import type { InvoicesService } from './invoices/service.js';
import type { Scheduler } from './scheduler/loop.js';

export interface AppDeps {
  config: Config;
  db: Db;
  keyring: Keyring;
  orgs: OrgService;
  settings: Settings;
  instance: InstanceSettings;
  cache: Cache;
  events: EventHub;
  daraja: DarajaFactory;
  operators: OperatorService;
  settingsService: SettingsService;
  moneyOut: MoneyOutService;
  /** M1: money in. Separate service from moneyOut so nothing that counts sends ever sees it. */
  collect: CollectService;
  /** M2: money that arrives without a request; registration, the pull check and the page's reads. */
  moneyIn: MoneyInService;
  /** M5: batches over ordinary sends. */
  bulk: BulkService;
  /** M7: Safaricom Bill Manager. */
  invoices: InvoicesService;
  /** Feature 2: the businesses one paybill serves, their customers, and the unmatched fixes. */
  businesses: BusinessesService;
  /** Present at boot; absent in tests that build the app without a scheduler. */
  scheduler?: Pick<Scheduler, 'lastTickAt'>;
  /** The fetch every Safaricom-facing call goes through. Set only by the local demo and the tests. */
  fetchImpl?: typeof fetch;
}

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);
  // A one-time latch recording that the deployment has actually been reached over https —
  // req.secure already honours X-Forwarded-Proto, but only from a hop `trust proxy` (set just
  // above) trusts, so this never trusts a forged header directly (see auth/middleware.ts).
  // `httpsSeen` is set synchronously on the first qualifying request so every later request in
  // this process takes the fast path with no settings read at all; the DB is only consulted
  // once, lazily, to avoid rewriting a value a previous run already persisted.
  let httpsSeen = false;
  app.use((req, _res, next) => {
    if (!httpsSeen && deps.config.nodeEnv === 'production' && req.secure) {
      httpsSeen = true;
      void deps.instance.get('https.seen').then((v) => { if (v !== 'true') return deps.instance.set('https.seen', 'true'); }).catch(() => {});
    }
    next();
  });
  // The callback stack gets its own JSON parser, mounted ahead of the global one, so a
  // malformed/oversized Safaricom body never reaches the global error middleware as a 500 —
  // callbackErrorHandler stores what it can and always acks 200.
  app.use(
    '/cb',
    express.json({ limit: '256kb', verify: (req, _res, buf) => { (req as Request).rawBody = buf.toString('utf8'); } }),
    callbackRoutes({ ...deps, handlers: { selftest: selftestHandler, balance: balanceHandler, b2c: b2cHandler, 'b2c/timeout': b2cTimeoutHandler, status: statusHandler, stk: stkHandler, reversal: reversalHandler, 'reversal/timeout': reversalTimeoutHandler, 'c2b/validate': c2bValidateHandler, 'c2b/confirm': c2bConfirmHandler, billmanager: billManagerHandler(deps.invoices), ratiba: ratibaHandler, express: expressHandler } }),
    callbackErrorHandler(deps),
  );
  app.use(express.json({ limit: '256kb' }));
  // Everything under /api and /healthz runs inside the caller's organisation. Static assets and the
  // SPA shell deliberately do not: they carry no organisation-scoped data, and a session lookup for
  // every image is a database round trip for nothing. The /cb stack above resolves its own
  // organisation from the secret in the URL (callbacks/router.ts).
  app.use('/api', orgContext(deps));
  app.use('/api', requirePasswordChanged);
  // One install, one organisation: there is no second tenant to be noisy at the expense of, so the
  // login lockout in auth/routes.ts is the whole of the rate limiting here. The /cb stack is
  // mounted above this line either way, so a callback is never limited — Safaricom always gets 200.
  // Spec 6.2: a suspended organisation is read-only and a closed one is refused.
  app.use('/api', requireOrgActive());
  app.use('/healthz', orgContext(deps));
  app.use('/healthz', healthRoutes(deps));
  app.use('/api/auth', authRoutes(deps.db, deps.config));
  app.use('/api/events', sseRoute(deps.events, deps.db));
  app.use('/api/settings', settingsRoutes(deps));
  app.use('/api/people', peopleRoutes(deps));
  app.use('/api/setup', setupRoutes(deps));
  app.use('/api/send', sendRoutes(deps));
  // M3: the reversal lives under the same mount as the phone send, so every money-out kind is
  // reached at one address shape. Its two callback paths are registered with the other handlers.
  app.use('/api/send', reversalRoutes(deps));
  app.use('/api/collect', collectRoutes(deps));
  app.use('/api/money-in', moneyInRoutes(deps));
  app.use('/api/approvals', approvalRoutes(deps));
  // Feature 5: the Waiting page's three sections in one read.
  app.use('/api/waiting', waitingRoutes(deps));
  app.use('/api/send/bulk', bulkRoutes(deps));
  app.use('/api/invoices', invoiceRoutes(deps));
  // Feature 1: the saved contact book, read by Send to phone and Bulk send.
  app.use('/api/contacts', contactsRoutes(deps));
  // Feature 2: businesses and their customers. The customer routes sit at their own address,
  // because a customer id already names its business; the design's paths are exactly these.
  app.use('/api/businesses', businessesRoutes(deps));
  app.use('/api/customers', customersRoutes(deps));
  // Feature 4: the inbox the writer fills and the bell reads.
  app.use('/api/notifications', notificationRoutes(deps));
  app.use('/api/requests', requestRoutes(deps));
  app.use('/api/balances', balanceRoutes(deps));
  app.use('/api/lookup', lookupRoutes(deps));
  app.use('/api/qr', qrRoutes(deps));
  app.use('/api/org', orgRoutes(deps));
  app.use('/api', notFound);

  const webDir = path.resolve(process.env.STUDIO_WEB_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'));
  const indexHtml = path.join(webDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    // /api is already fully handled above (terminated by the `notFound` mount), but callbackRoutes
    // only defines POST handlers — a GET under /cb would otherwise fall through to here and could
    // be shadowed by an accidental web/dist/cb/... file, or by the SPA fallback. Excluding both
    // ahead of express.static closes that off for every method.
    app.use((req, res, next) => {
      if (/^\/(api|cb)(\/|$)/.test(req.path)) return notFound(req, res, next);
      next();
    });
    // The manual's machine copy (guide.md, llms.txt) is for AI agents and scripts, never for a person
    // in a browser: a request that prefers HTML gets the app instead, whose router sends it Home.
    app.use((req, res, next) => {
      if ((req.path === '/guide.md' || req.path === '/llms.txt') && req.accepts(['text/markdown', 'text/plain', 'text/html']) === 'text/html') return res.sendFile(indexHtml);
      next();
    });
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => res.sendFile(indexHtml));
  }
  app.use(errorMiddleware);
  return app;
}
