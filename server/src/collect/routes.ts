import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { Config } from '../config.js';
import type { Settings } from '../settings/store.js';
import { requireAuth, requireCsrf, requireHttps, requireUnlocked } from '../auth/middleware.js';
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
  /** Brief 2, item 1: a saved account instead of typed words. Its full number becomes the reference. */
  accountId: z.string().uuid().optional(),
  description: z.string().trim().max(13).optional(),
  confirmDuplicate: z.boolean().optional(),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, { message: 'Enter a real date.' });
const standingOrder = z.object({
  name: z.string().trim().min(1).max(60), phone: z.string().trim().min(1).max(20), amountCents: z.number().int().positive(),
  frequency: z.enum(['1', '2', '3', '4', '5', '6', '7', '8']), startDate: day, endDate: day,
  accountReference: z.string().trim().min(1).max(12), transactionDesc: z.string().trim().max(13).default(''), transactionType: z.enum(['paybill', 'buygoods']).default('paybill'),
});
const expressCheckout = z.object({ till: z.string().trim().min(1).max(10), amountCents: z.number().int().positive(), paymentRef: z.string().trim().min(1).max(20), partnerName: z.string().trim().max(40).default(''), confirmDuplicate: z.boolean().optional() });
const bongaCalculate = z.object({ points: z.number().int().positive().max(10_000_000) });
const bongaRedeem = z.object({ phone: z.string().trim().min(1).max(20), points: z.number().int().positive().max(10_000_000), accountReference: z.string().trim().min(1).max(20), confirmDuplicate: z.boolean().optional() });

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
 * till or teach them to share one. Brief 2, item 3 adds the lock's own gate instead: a phone put
 * down cannot raise one of these at all until its PIN is entered.
 */
export function collectRoutes(deps: AppDeps): Router {
  const r = Router();
  r.post('/stk', requireAuth(deps.db), requireCsrf, requireUnlocked, requirePermission(deps.db, 'stk.request'), requireCollectReady(deps), async (req, res, next) => {
    try {
      const b = parse(askToPay, req.body);
      const v = await deps.collect.askToPay(b, { personId: req.person!.id, ip: clientIp(req) });
      res.status(201).json(v);
    } catch (e) { next(e); }
  });
  const actor = (req: Parameters<typeof clientIp>[0] & { person?: { id: string } }) => ({ personId: req.person!.id, ip: clientIp(req) });
  // M8, M9, M10: money in like STK, so the same readiness and no step-up password.
  r.post('/ratiba', requireAuth(deps.db), requireCsrf, requireUnlocked, requirePermission(deps.db, 'standing_orders.manage'), requireCollectReady(deps), async (req, res, next) => {
    try { res.status(201).json(await deps.collect.standingOrder(parse(standingOrder, req.body), actor(req))); } catch (e) { next(e); }
  });
  r.post('/express', requireAuth(deps.db), requireCsrf, requireUnlocked, requirePermission(deps.db, 'express.checkout'), requireCollectReady(deps), async (req, res, next) => {
    try { res.status(201).json(await deps.collect.expressCheckout(parse(expressCheckout, req.body), actor(req))); } catch (e) { next(e); }
  });
  r.post('/bonga/calculate', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'bonga.redeem'), async (req, res, next) => {
    try { res.json(await deps.collect.bongaCalculate(parse(bongaCalculate, req.body).points)); } catch (e) { next(e); }
  });
  r.post('/bonga/redeem', requireAuth(deps.db), requireCsrf, requireUnlocked, requirePermission(deps.db, 'bonga.redeem'), requireCollectReady(deps), async (req, res, next) => {
    try { res.status(201).json(await deps.collect.bongaRedeem(parse(bongaRedeem, req.body), actor(req))); } catch (e) { next(e); }
  });
  return r;
}
