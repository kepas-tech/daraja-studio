import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { listRequests } from '../money_out/reads.js';
import { clientIp } from '../util/ip.js';

/**
 * Registration is the owner's, behind a password: it tells Safaricom where to post real money's
 * confirmations. Reading and the missed-payments check are for anyone allowed to see money in.
 */
export function moneyInRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get('/status', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await deps.moneyIn.status()); } catch (e) { next(e); } });
  r.get('/recent', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await listRequests(deps.db, { type: ['c2b'], limit: 20 }, deps.config.egressIps)); } catch (e) { next(e); } });
  r.post('/register', requireAuth(deps.db), requireCsrf, requireOwner, requireStepUp(deps.db), async (req, res, next) => {
    try { res.status(202).json(await deps.moneyIn.register({ personId: req.person!.id, ip: clientIp(req) })); } catch (e) { next(e); }
  });
  r.post('/check', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await deps.moneyIn.checkMissed()); } catch (e) { next(e); } });
  return r;
}
