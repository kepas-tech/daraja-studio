import express, { type Request, type Router } from 'express';
import { createRequire } from 'node:module';
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
import { webauthnRoutes } from './auth/webauthnRoutes.js';
import type { WebauthnService } from './auth/webauthn.js';
import { requireAuth, requireCsrf, requirePasswordChanged } from './auth/middleware.js';
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
import { problemsRoutes } from './health/problemsRoutes.js';
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
import { accountsRoutes, businessTypesRoutes, businessesRoutes } from './businesses/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { pushRoutes } from './push/routes.js';
import { reportsRoutes } from './reports/routes.js';
import { auditRoutes } from './audit/routes.js';
import { feeRoutes } from './fees/routes.js';
import type { BusinessesService } from './businesses/service.js';
import type { BusinessTypesService } from './businesses/types.js';
import type { StatementService } from './businesses/statement.js';
import type { ReconcileService } from './reconcile/service.js';
import { reconcileRoutes } from './reconcile/routes.js';
import type { CasesService } from './cases/service.js';
import { caseRoutes, requestCaseRoutes } from './cases/routes.js';
import type { ApiKeysService } from './keys/service.js';
import { apiKeyRoutes } from './keys/routes.js';
import type { WebhooksService } from './webhooks/service.js';
import type { NameBackfill } from './money_in/names.js';
import { webhookRoutes } from './webhooks/routes.js';
import type { InvoicesService } from './invoices/service.js';
import type { Scheduler } from './scheduler/loop.js';
import type { PushService } from './push/service.js';
import type { ProblemService } from './health/problems.js';
import { registerModule, type ModuleDecl } from './modules/registry.js';
import type { ModuleService } from './modules/service.js';
import type { SweepService } from './sweep/service.js';
import { sweepRoutes } from './sweep/routes.js';
import { moduleRoutes } from './modules/routes.js';

/** The package installed beside Studio, if there is one. */
export const EXTENSION_PACKAGE = '@kepas/studio-host';

/**
 * Where a package's own routes are mounted, and nowhere else.
 *
 * `x` is reserved for this and for nothing else: no part of the product answers under it, and none
 * ever may, because a package's address must not be able to collide with the studio's own. A
 * package mounts one router, and the name it picks becomes the last part of the address.
 */
export const EXTENSION_ROUTE_PREFIX = '/api/x';

/**
 * The version of the extension api, and a promise rather than a label.
 *
 * A package reads it and may refuse to load against one it does not know. It goes up whenever
 * anything below changes in a way a package has to know about — a part of the api that goes, one
 * that changes shape, or one whose meaning moves. It does not go up for something added, because an
 * older package simply does not use what it does not know about.
 */
export const EXTENSION_API_VERSION = 1;

/** One router a package asked to have mounted. The path is built here, never by the package. */
export interface ExtensionRouter {
  name: string;
  path: string;
  router: Router;
}

/**
 * What an installed package is handed when it is loaded. Every part of it is a promise kept for
 * ever, so it grows only on a decision and by as little as the job needs.
 *
 *   db        the database handle the rest of the studio uses, in the caller's organisation
 *   settings  the settings reader, for the settings a package reads
 *   orgs      creating an organisation through the studio's own service, never by its own SQL
 *   version   the api version, so a package can refuse one it does not know
 *   registerModule   declare a part of the studio (the first widening, step two)
 *   registerRouter   mount one router of its own under the reserved namespace
 *
 * Deliberately not here: permissions, menu entries and tiers. The layer a package adds is the
 * operator's own and needs none of them, and each would be another promise to keep.
 */
export interface ExtensionApi {
  readonly version: number;
  readonly db: Db;
  readonly settings: Settings;
  readonly orgs: Pick<OrgService, 'create'>;
  registerModule(decl: ModuleDecl): void;
  registerRouter(name: string, router: Router): void;
}

/** What the boot hands the loader: the parts of a running studio a package is given. */
export interface ExtensionHost {
  db: Db;
  settings: Settings;
  orgs: Pick<OrgService, 'create'>;
}

/** What the loader found: whether a package is installed, and whatever it mounted. */
export interface ExtensionLoad {
  loaded: boolean;
  routers: ExtensionRouter[];
}

/** A router's name is one plain path segment: lower case, two to thirty, starting with a letter. */
const ROUTER_NAME = /^[a-z][a-z0-9-]{1,29}$/;

const resolvesFrom = createRequire(import.meta.url);

/**
 * Load the package installed beside Studio. A package exports `register`, which is handed the API
 * above, and whatever it mounted comes back for the app to mount.
 *
 * Absent and broken are two different things, and the whole point is telling them apart. A package
 * that is not installed is silence: a studio without one boots and serves exactly as it does with
 * no seam at all. A package that **is** installed and cannot be loaded — the file throws, a
 * dependency of it is missing, or its own `register` throws — stops the boot, naming the package
 * and what went wrong. Half a package would take its parts away from a studio that has tenants on
 * it, and nobody would notice until something was missing.
 *
 * Nothing here decides what a package may reach once a request arrives: the router it mounts is
 * mounted by `buildApp` inside the studio's own middleware, so it carries the organisation
 * context, the session and the CSRF check whether the package asks for them or not.
 */
export async function loadExtension(host: ExtensionHost, specifier: string = EXTENSION_PACKAGE): Promise<ExtensionLoad> {
  // Resolvable or not is the question of whether this package is installed at all, and it is asked
  // before the import so that nothing depends on guessing the shape of an error.
  try { resolvesFrom.resolve(specifier); } catch { return { loaded: false, routers: [] }; }
  const routers: ExtensionRouter[] = [];
  const api: ExtensionApi = {
    version: EXTENSION_API_VERSION,
    db: host.db,
    settings: host.settings,
    orgs: host.orgs,
    registerModule,
    registerRouter(name, router) {
      // One router, and its address is built here: a package picks a name, never a path, so nothing
      // it can write takes it outside the namespace the studio reserved for it.
      if (routers.length > 0) {
        throw new Error('a package mounts one router, and this one already mounted ' + routers[0]!.path);
      }
      if (typeof name !== 'string' || !ROUTER_NAME.test(name)) {
        throw new Error('a router name is lower-case letters, digits and hyphens, two to thirty of them, starting with a letter: ' + String(name));
      }
      if (typeof router !== 'function') {
        throw new Error('a router must be an express router: ' + String(name));
      }
      routers.push({ name, path: EXTENSION_ROUTE_PREFIX + '/' + name, router });
    },
  };
  try {
    const mod = (await import(specifier)) as { register?: (api: ExtensionApi) => void };
    if (typeof mod.register === 'function') mod.register(api);
    return { loaded: true, routers };
  } catch (e) {
    throw new Error(`${specifier} is installed but could not be loaded: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

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
  /** Feature 2: the businesses one paybill serves, their account numbers, and the unmatched fixes. */
  businesses: BusinessesService;
  /** Round 3, phase B: the kinds of business, and the words each kind brings with it. */
  businessTypes: BusinessTypesService;
  /** Round 3, phase C: one account's running statement, and who is behind. */
  statements: StatementService;
  /** Round 3, phase D-1: Safaricom's record against Studio's, read only. */
  reconcile: ReconcileService;
  /** Round 3, phase D-5: the case file on a payment. */
  cases: CasesService;
  /** Round 3, phase E: keys another system calls this studio with. */
  apiKeys: ApiKeysService;
  /** Round 3, phase E: the webhook address, its secret, and the deliveries queue. */
  webhooks: WebhooksService;
  /** Round 4: filling in the payer names Studio never received. */
  nameBackfill: NameBackfill;
  /** Brief 2, item 2: the three states that mean something is wrong, for Home's banner. */
  problems: ProblemService;
  /** Step one of the tiers-and-modules design: what this studio does, and the tier it started from. */
  modules: ModuleService;
  /** Step three of nine: what arrives for a business, sent on to its own phone on its own timetable. */
  sweep: SweepService;
  /** Brief 2, item 5b: the fingerprint ceremonies. Absent in tests that build the app without one. */
  webauthn?: WebauthnService;
  /** Feature 12: web push to the devices that subscribed. Absent in tests that build the app without it. */
  push?: PushService;
  /** Present at boot; absent in tests that build the app without a scheduler. */
  scheduler?: Pick<Scheduler, 'lastTickAt'>;
  /** The fetch every Safaricom-facing call goes through. Set only by the local demo and the tests. */
  fetchImpl?: typeof fetch;
  /** What an installed package mounted, from loadExtension. Absent when nothing is installed. */
  extensionRouters?: ExtensionRouter[];
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
  // The address move. While the deployment names the hostnames it has left behind, a GET on one of
  // them is sent on to the studio's own address, carrying the path and the query; the callback
  // paths are not, because a request Safaricom was given the old address for has to be answered
  // there. Only GET: a callback or a machine posting to the old address is served, never bounced.
  // The rule is inert without the configuration, and STUDIO_REDIRECT_UNTIL ends it by itself.
  if (deps.config.redirectOldAddresses.length > 0 && deps.config.publicUrl && deps.config.redirectUntil) {
    const until = deps.config.redirectUntil.getTime();
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (Date.now() > until) return next();
      const host = req.hostname.toLowerCase();
      if (!deps.config.redirectOldAddresses.includes(host)) return next();
      if (/^\/cb(\/|$)/.test(req.path)) return next();
      // An address is only an old one while it is not the studio's own: this is what stops a
      // half-done move from redirecting the studio to itself.
      const target = new URL(deps.config.publicUrl!);
      if (target.hostname.toLowerCase() === host) return next();
      res.redirect(301, target.origin + req.originalUrl);
    });
  }
  // The callback stack gets its own JSON parser, mounted ahead of the global one, so a
  // malformed/oversized Safaricom body never reaches the global error middleware as a 500 —
  // callbackErrorHandler stores what it can and always acks 200.
  app.use(
    '/cb',
    express.json({ limit: '256kb', verify: (req, _res, buf) => { (req as Request).rawBody = buf.toString('utf8'); } }),
    callbackRoutes({ ...deps, failover: (requestId, failedOperatorId) => deps.moneyOut.failover(requestId, failedOperatorId), handlers: { selftest: selftestHandler, balance: balanceHandler, b2c: b2cHandler, 'b2c/timeout': b2cTimeoutHandler, status: statusHandler, stk: stkHandler, reversal: reversalHandler, 'reversal/timeout': reversalTimeoutHandler, 'c2b/validate': c2bValidateHandler, 'c2b/confirm': c2bConfirmHandler, billmanager: billManagerHandler(deps.invoices), ratiba: ratibaHandler, express: expressHandler } }),
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
  // Brief 2, item 5b. Mounted before the rest of /api/auth so a locked session's two open routes are
  // reached without passing anything else.
  if (deps.webauthn) app.use('/api/auth/webauthn', webauthnRoutes({ db: deps.db, webauthn: deps.webauthn }));
  app.use('/api/auth', authRoutes(deps.db, deps.config, deps.modules));
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
  // Brief 2, item 2: what Home's banner needs. Read-only, and the owner gets the specifics.
  app.use('/api/health/problems', problemsRoutes(deps));
  // Feature 5: the Waiting page's three sections in one read.
  app.use('/api/waiting', waitingRoutes(deps));
  app.use('/api/send/bulk', bulkRoutes(deps));
  app.use('/api/invoices', invoiceRoutes(deps));
  // Feature 1: the saved contact book, read by Send to phone and Bulk send.
  app.use('/api/contacts', contactsRoutes(deps));
  // Brief 2, item 1: businesses and their account numbers. The account routes sit at their own
  // address, because an account id already names its business; the design's paths are these.
  app.use('/api/businesses', businessesRoutes(deps));
  app.use('/api/sweep', sweepRoutes(deps));
  app.use('/api/business-types', businessTypesRoutes(deps));
  // Round 3, phase D-1: check nothing is missing. A read that reaches Safaricom for its record.
  app.use('/api/reconcile', reconcileRoutes(deps));
  // Round 3, phase D-5: the payment's own case file, then what is done to a case. The first is
  // mounted with the payment's id in the path, so it sits above the requests router.
  app.use('/api/requests/:id/case', requestCaseRoutes(deps));
  app.use('/api/cases', caseRoutes(deps));
  // Round 3, phase E: the developer side, under Advanced.
  app.use('/api/keys', apiKeyRoutes(deps));
  app.use('/api/webhooks', webhookRoutes(deps));
  app.use('/api/accounts', accountsRoutes(deps));
  // Feature 4: the inbox the writer fills and the bell reads.
  app.use('/api/notifications', notificationRoutes(deps));
  // Feature 12: the browser's subscription and the test message. Off, harmlessly, without keys.
  app.use('/api/push', pushRoutes(deps));
  // Feature 6: the week's numbers, read-only. Nothing under it writes a row.
  app.use('/api/reports', reportsRoutes(deps));
  // Feature 10: who did what. Owner only, and read-only — audit_log refuses every write by trigger.
  app.use('/api/audit', auditRoutes(deps));
  // Feature 11: Safaricom's own charge per row. Read by the send review, History and Settings ›
  // Charges; only the owner corrects a band.
  app.use('/api/fees', feeRoutes(deps));
  app.use('/api/requests', requestRoutes(deps));
  app.use('/api/balances', balanceRoutes(deps));
  app.use('/api/lookup', lookupRoutes(deps));
  app.use('/api/qr', qrRoutes(deps));
  app.use('/api/org', orgRoutes(deps));
  // Step one: the page under Organisation that decides which parts of Studio exist here. Owner only,
  // and every change behind the step-up.
  app.use('/api/modules', moduleRoutes(deps));
  // A package's own routes, under the namespace reserved for them and nowhere else, mounted last so
  // they cannot shadow a part of the studio. They are mounted here, inside the /api chain above, so
  // they carry the organisation context, the password gate and the active-organisation rule exactly
  // as every router the studio mounts does — and the session and the CSRF check are applied here
  // rather than left to the package, so neither can be left out by accident.
  for (const extension of deps.extensionRouters ?? []) {
    app.use(extension.path, requireAuth(deps.db), requireCsrf, extension.router);
  }
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
    // The service worker (feature 12) must never be a stale one: a browser holds on to it far
    // longer than an asset, so it alone is served no-cache while every other file keeps the hour.
    app.get('/sw.js', (_req, res) => res.sendFile(path.join(webDir, 'sw.js'), { headers: { 'Cache-Control': 'no-cache' } }));
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => res.sendFile(indexHtml));
  }
  app.use(errorMiddleware);
  return app;
}
