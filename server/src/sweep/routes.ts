import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireStepUp } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { requireModule } from '../modules/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { SCHEDULES } from './window.js';

/**
 * The Sweep-through page's own routes. Reading is open to any signed-in person — the page says
 * where a business's money is going, which is everybody's business. Setting it up takes
 * sweep.manage and the owner's password, because it decides where money goes. Stopping and starting
 * are one press: no password, no dialog, and the money stays owed and visible either way.
 */

const uuid = z.string().uuid();
const phone = z.string().trim().max(20).nullable();
const fee = z.object({
  percentBp: z.number().int().min(0).max(10_000),
  flatCents: z.number().int().min(0).max(1_000_000_000),
  floorCents: z.number().int().min(0).max(1_000_000_000).nullable(),
  ceilingCents: z.number().int().min(0).max(1_000_000_000).nullable(),
}).strict();
const saveSchema = z.object({
  destinationPhone: phone,
  schedule: z.enum(SCHEDULES),
  hour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(0).max(6),
  fee,
}).strict();
/** One press: the body carries the state it wants and nothing else. */
const stopSchema = z.object({ stopped: z.boolean() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

const actor = (req: Request) => ({ personId: req.person!.id, ip: clientIp(req) });

/** A business id that is not one is a 404, never a 400: nothing there to look at either way. */
function businessId(req: Request): string {
  const id = String(req.params.businessId);
  if (!uuid.safeParse(id).success) throw new HttpError(404, 'not_found', 'That business does not exist.');
  return id;
}

export function sweepRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'sweep'));

  r.get('/', async (_req, res, next) => {
    try { res.json(await deps.sweep.list()); } catch (e) { next(e); }
  });

  r.get('/:businessId', async (req, res, next) => {
    try { res.json(await deps.sweep.one(businessId(req))); } catch (e) { next(e); }
  });

  // Where the money goes and when it goes there. Both halves need the step-up; either one changing
  // writes an audit row naming the before and the after.
  r.post('/:businessId', requirePermission(deps.db, 'sweep.manage'), requireStepUp(deps.db), async (req, res, next) => {
    try {
      const id = businessId(req);
      const body = parse(saveSchema, req.body);
      res.json(await deps.sweep.save(id, { ...body, fee: body.fee }, actor(req)));
    } catch (e) { next(e); }
  });

  // One press, the way the design asks for it: stopping has to be the easy thing to do.
  r.post('/:businessId/stop', requirePermission(deps.db, 'sweep.manage'), async (req, res, next) => {
    try {
      const id = businessId(req);
      res.json(await deps.sweep.setStopped(id, parse(stopSchema, req.body).stopped, actor(req)));
    } catch (e) { next(e); }
  });

  return r;
}
