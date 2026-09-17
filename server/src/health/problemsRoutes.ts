import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth } from '../auth/middleware.js';

/**
 * Brief 2, item 2. Any signed-in person may read this — the sentence is for everybody — but the
 * specifics behind it (which operator, how long) are the owner's, and the server withholds them
 * rather than trusting the page to hide them. Nothing here is cached: a page that re-reads sees
 * the truth, and the banner goes when the state does.
 */
export function problemsRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get('/', requireAuth(deps.db), async (req, res, next) => {
    try { res.json({ items: await deps.problems.list(req.person!.is_owner === true) }); }
    catch (e) { next(e); }
  });
  return r;
}
