import { Router } from 'express';
import { createRequire } from 'node:module';
import type { AppDeps } from '../app.js';
import { withOrg, withSystem } from '../db/pool.js';
import { checkDbRole } from '../boot/roleCheck.js';
import { clientIp, isLoopback } from '../util/ip.js';

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export const VERSION = readVersion();

export function healthRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get('/', async (req, res) => {
    // /healthz has no auth — the Docker healthcheck and a local operator hit it anonymously, and so
    // does anyone on the public internet, since deploy/Caddyfile reverse-proxies everything to this
    // service. orgCount (how many tenants this install has) and dbRoleOk (whether row-level security
    // is actually enforced) are exactly the two facts an attacker would want before doing anything
    // noisy, so they are shown only to the loopback interface — the Docker healthcheck and local
    // operators.
    const loopback = isLoopback(clientIp(req));
    try {
      const [{ n }] = await deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM jobs WHERE done_at IS NULL AND run_at <= now()');

      let tenantFacts: { orgCount: number; dbRoleOk: boolean } | Record<string, never> = {};
      if (loopback) {
        const [{ n: orgs }] = await withSystem(() => deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM orgs'));
        const dbRoleOk = (await checkDbRole(deps.db)) === null;
        tenantFacts = { orgCount: Number(orgs), dbRoleOk };
      }

      // These fields read this install's own settings, which needs an organisation in scope. An
      // anonymous /healthz request enters no context (http/orgContext.ts passes it straight
      // through), so they are read under the fallback organisation set at boot.
      let orgFields: { lastCallbackAt: string | null; publicVerified: boolean; b2cApi: { setting: 'v1' | 'v3' | 'auto'; detected: 'v1' | 'v3' | null } } | Record<string, never> = {};
      const fallback = deps.db.getFallbackOrg();
      if (fallback) {
        orgFields = await withOrg(fallback, async () => {
          const [cb] = await deps.db.query<{ at: Date | null }>('SELECT max(received_at) AS at FROM callbacks_raw');
          const verified = await deps.settings.get('public.verifiedAt');
          const env = ((await deps.settings.get('daraja.environment')) === 'production') ? 'production' : 'sandbox';
          const b2c = await deps.settings.getMany([`env.${env}.b2cApi`, `env.${env}.b2cApiDetected`]);
          const b2cApiSetting = b2c[`env.${env}.b2cApi`];
          const b2cApiDetected = b2c[`env.${env}.b2cApiDetected`];
          return {
            lastCallbackAt: cb?.at?.toISOString() ?? null,
            publicVerified: !!verified,
            b2cApi: { setting: b2cApiSetting === 'v1' || b2cApiSetting === 'v3' ? b2cApiSetting : 'auto', detected: b2cApiDetected === 'v1' || b2cApiDetected === 'v3' ? b2cApiDetected : null },
          };
        });
      }

      res.json({
        ok: true, db: true,
        jobsPending: Number(n), version: VERSION,
        schedulerLastTickAt: deps.scheduler?.lastTickAt()?.toISOString() ?? null,
        sendCapCents: deps.config.maxSendCents,
        // Whether web push has keys. A boolean, never a key.
        pushConfigured: deps.config.vapid !== null,
        ...tenantFacts,
        ...orgFields,
      });
    } catch {
      res.status(503).json({
        ok: false, db: false,
        jobsPending: -1, version: VERSION,
        schedulerLastTickAt: null, sendCapCents: deps.config.maxSendCents,
        pushConfigured: deps.config.vapid !== null,
        ...(loopback ? { orgCount: -1, dbRoleOk: false } : {}),
      });
    }
  });
  return r;
}
