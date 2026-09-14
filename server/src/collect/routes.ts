import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { Config } from '../config.js';
import type { Settings } from '../settings/store.js';
import { requireAuth, requireCsrf, requireHttps } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { PUBLIC_URL_UNVERIFIED } from '../money_out/ready.js';
import { ORG_CLOSED, ORG_SUSPENDED } from '../http/orgActive.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';

const askToPay = z.object({
  phone: z.string().trim().min(1).max(20),
  amountCents: z.number().int().positive(),
  // Safaricom shows this to the payer and puts it on their statement, so it is the one field a
  // business uses to recognise the payment later. Required, unlike a send's optional remarks.
  accountReference: z.string().trim().min(1).max(12),
  description: z.string().trim().max(13).optional(),
  confirmDuplicate: z.boolean().optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * The same readiness `requireMoneyReady` asks for, minus the API operator — an STK push
 * authenticates with the app's OAuth pair and the shortcode's passkey, never with an initiator
 * credential, so requiring a verified operator here would refuse an organisation that can
 * legitimately take money. The passkey itself is checked in the service, which is where a missing
 * one can be reported with the setting that fixes it.
 */
export function requireCollectReady(deps: { config: Config; settings: Settings }): RequestHandler {
  const https = requireHttps(deps.config);
  return (req, res, next) => {
    https(req, res, async (err?: unknown) => {
      if (err) return next(err);
      try {
        const status = req.org?.status;
        if (status === 'closed') throw new HttpError(409, 'org_closed', ORG_CLOSED);
        if (status === 'suspended') throw new HttpError(409, 'org_suspended', ORG_SUSPENDED);
        if (!(await deps.settings.get('public.verifiedAt'))) throw new HttpError(409, 'public_url_unverified', PUBLIC_URL_UNVERIFIED);
        next();
      } catch (e) { next(e); }
    });
  };
}

/**
 * No step-up password here, unlike every send route. A password is asked for before money leaves
 * the organisation or before who may move it changes (`copy.confirm.why`); asking a customer to pay
 * does neither. A counter clerk raises these all day, and a password on each would either stop the
 * till or teach them to share one.
 */
export function collectRoutes(deps: AppDeps): Router {
  const r = Router();
  r.post('/stk', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'stk.request'), requireCollectReady(deps), async (req, res, next) => {
    try {
      const b = parse(askToPay, req.body);
      const v = await deps.collect.askToPay(b, { personId: req.person!.id, ip: clientIp(req) });
      res.status(201).json(v);
    } catch (e) { next(e); }
  });
  return r;
}
