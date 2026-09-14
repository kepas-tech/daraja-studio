import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { currentOrgId } from '../db/pool.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';

const wipeSchema = z.object({ confirmName: z.string().trim().min(1).max(120) });

/** The organisation's own destructive action: wipe everything and return to first-run setup. */
export function orgRoutes(deps: AppDeps): Router {
  const r = Router();
  r.post('/wipe', requireAuth(deps.db), requireCsrf, requireOwner, requireStepUp(deps.db), async (req, res, next) => {
    try {
      const parsed = wipeSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'invalid', 'Type the organisation name to confirm.');
      const orgId = currentOrgId();
      if (!orgId) throw new HttpError(500, 'no_org', 'No organisation in scope.');
      await deps.orgs.wipe(orgId, parsed.data.confirmName, { personId: req.person!.id, ip: clientIp(req) });
      res.status(204).end();
    } catch (e) { next(e); }
  });
  return r;
}
