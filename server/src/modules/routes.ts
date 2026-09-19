import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { isTierKey } from './registry.js';

const body = z.object({ enabled: z.boolean() });
const tierBody = z.object({ tier: z.string() });

function parse<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'invalid', message);
  return r.data;
}

/**
 * The page under Organisation: what this studio does. Reading it is the owner's; every change is the
 * owner's and asks for the step-up, because a switch here decides which parts of the studio exist at
 * all. The tier preview is a read that writes nothing, so it does not ask for a password.
 */
export function moduleRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireOwner);
  const svc = deps.modules;
  const stepUp = requireStepUp(deps.db);
  const a = (req: { person?: { id: string } } & Parameters<typeof clientIp>[0]) => ({ personId: req.person?.id ?? '', ip: clientIp(req) });

  r.get('/', async (_req, res, next) => { try { res.json(await svc.state()); } catch (e) { next(e); } });
  // What the change would do, before anybody commits to it.
  r.post('/tier/preview', async (req, res, next) => {
    try {
      const { tier } = parse(tierBody, req.body, 'Say which tier.');
      if (!isTierKey(tier)) throw new HttpError(400, 'invalid', 'That is not one of the three tiers.');
      res.json(await svc.preview(tier));
    } catch (e) { next(e); }
  });
  r.post('/tier', stepUp, async (req, res, next) => {
    try {
      const { tier } = parse(tierBody, req.body, 'Say which tier.');
      if (!isTierKey(tier)) throw new HttpError(400, 'invalid', 'That is not one of the three tiers.');
      res.json(await svc.setTier(tier, a(req)));
    } catch (e) { next(e); }
  });
  r.post('/:key', stepUp, async (req, res, next) => {
    try {
      const { enabled } = parse(body, req.body, 'Say whether it is on or off.');
      res.json(await svc.set(String(req.params.key), enabled, a(req)));
    } catch (e) { next(e); }
  });
  return r;
}
