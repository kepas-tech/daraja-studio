import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';

/**
 * Brief 2, item 1. Reading is open to any signed-in person, because the Send, Bulk, Ask-to-pay, QR
 * and invoice screens all pick from this list; writing takes the new businesses.manage, which is in
 * no role preset — deciding whose money a payment is, and naming the account a payer will use, is
 * the owner's job. Every write lands in audit_log.
 *
 * No account body has a number field, and every one of them is strict: a client that sends a number
 * for Studio to use gets a 400 rather than a row. The number is always minted here.
 */

const name = z.string().trim().min(1).max(80);
const phone = z.string().trim().min(1).max(20).optional();
const note = z.string().trim().max(200).optional();
const uuid = z.string().uuid();

const createSchema = z.object({
  name,
  code: z.string().trim().regex(/^[0-9]{3}$/, 'A business code is three digits, like 007.').optional(),
});
const updateSchema = z.object({ name, active: z.boolean() });
/** Strict on purpose: a number is Studio's to mint, so it is not a field of any account body. */
const accountSchema = z.object({ name, phone, note }).strict();
const assignSchema = z.object({ businessId: uuid, accountId: uuid.nullish() });
const listSchema = z.object({ q: z.string().trim().max(80).optional() });
const isRealDay = (s: string) => {
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const daySchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, { message: 'Enter a real date.' }).optional() });
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const NOT_FOUND = 'That business does not exist.';
const ACCOUNT_NOT_FOUND = 'That account does not exist.';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

const actor = (req: Request) => ({ personId: req.person!.id, ip: clientIp(req) });

export function businessesRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf);

  r.get('/', async (_req, res, next) => {
    try { res.json(await deps.businesses.list()); } catch (e) { next(e); }
  });

  // Today's in and out per business, for Home. Read-only and cheap: one grouped query.
  r.get('/summary', async (req, res, next) => {
    try { res.json(await deps.businesses.summary(parse(daySchema, req.query).day)); } catch (e) { next(e); }
  });

  r.post('/', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const b = parse(createSchema, req.body);
      res.status(201).json(await deps.businesses.create(b.name, b.code, actor(req)));
    } catch (e) { next(e); }
  });

  // The one-click fix on Money in. It labels a row and nothing else.
  r.post('/assign/:requestId', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.requestId);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That payment does not exist.');
      const b = parse(assignSchema, req.body);
      res.json(await deps.businesses.assign(id, b.businessId, b.accountId ?? null, actor(req)));
    } catch (e) { next(e); }
  });

  r.put('/:id', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const b = parse(updateSchema, req.body);
      res.json(await deps.businesses.update(id, b.name, b.active, actor(req)));
    } catch (e) { next(e); }
  });

  r.get('/:id/accounts', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const q = parse(listSchema, req.query).q;
      res.json({ items: await deps.businesses.accounts(id, q) });
    } catch (e) { next(e); }
  });

  r.post('/:id/accounts', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const b = parse(accountSchema, req.body);
      res.status(201).json(await deps.businesses.addAccount(id, b, actor(req)));
    } catch (e) { next(e); }
  });

  return r;
}

/** The account routes live at their own address, because an account id already names its business. */
export function accountsRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf);

  // An account under a customer. Refused a level deeper: an account under an account is not allowed.
  r.post('/:id/children', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      const b = parse(accountSchema, req.body);
      res.status(201).json(await deps.businesses.addChild(id, b, actor(req)));
    } catch (e) { next(e); }
  });

  r.put('/:id', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      const b = parse(accountSchema, req.body);
      res.json(await deps.businesses.updateAccount(id, b, actor(req)));
    } catch (e) { next(e); }
  });

  r.delete('/:id', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      await deps.businesses.retireAccount(id, actor(req));
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
