import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { requireModule } from '../modules/middleware.js';
import { HttpError } from '../util/errors.js';

/**
 * Round 3, phase D-1: check nothing is missing. One read: it asks Safaricom for its own record of a
 * window and answers with what does not agree with Studio's rows. It is a POST because it carries
 * the window and reaches Safaricom, not because it changes anything — nothing here writes.
 */
const checkSchema = z.object({ days: z.number().int().min(1).max(90).default(7) }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

export function reconcileRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'reconcile'), requirePermission(deps.db, 'money_in.view'));
  r.post('/', async (req, res, next) => {
    try { res.json(await deps.reconcile.check(parse(checkSchema, req.body).days)); } catch (e) { next(e); }
  });
  return r;
}
