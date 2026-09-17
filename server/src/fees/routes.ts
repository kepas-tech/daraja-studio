import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { createFeesService, FEE_KINDS, type FeeKind } from './service.js';

const amount = z.number().int().min(0).max(1_000_000_000);
const chargeQuery = z.object({ kind: z.enum(['c2b', 'b2c', 'b2b']), amountCents: z.coerce.number().int().min(0).max(1_000_000_000) });
const putSchema = z.object({
  bands: z.array(z.object({ minCents: amount, maxCents: amount, chargeCents: amount })).min(1).max(60),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * Feature 11. Safaricom's own charge per row: the bands are read by whoever may look a payment up,
 * because the send review and History both quote a figure, and corrected only by the owner with
 * their password. The domain rules (no overlap, whole shillings, at least one band) live in the
 * service, so the route cannot be the only thing enforcing them.
 */
export function feeRoutes(deps: AppDeps): Router {
  const r = Router();
  const fees = createFeesService({ db: deps.db });
  r.use(requireAuth(deps.db), requireCsrf);

  r.get('/', requirePermission(deps.db, 'lookup.view'), async (_req, res, next) => {
    try { res.json({ items: await fees.list() }); } catch (e) { next(e); }
  });

  r.get('/charge', requirePermission(deps.db, 'lookup.view'), async (req, res, next) => {
    try {
      const q = parse(chargeQuery, req.query);
      res.json({ chargeCents: await fees.chargeFor(q.kind, q.amountCents) });
    } catch (e) { next(e); }
  });

  r.put('/:kind', requireOwner, requireStepUp(deps.db), async (req, res, next) => {
    try {
      const kind = String(req.params.kind);
      if (!FEE_KINDS.includes(kind as FeeKind)) throw new HttpError(404, 'not_found', 'That tariff does not exist.');
      const b = parse(putSchema, req.body);
      res.json({ items: await fees.replace(kind as FeeKind, b.bands, { personId: req.person?.id ?? null, ip: clientIp(req) }) });
    } catch (e) { next(e); }
  });

  return r;
}
