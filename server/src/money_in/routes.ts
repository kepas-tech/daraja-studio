import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { listRequests } from '../money_out/reads.js';
import { INCOMING_TYPES } from '../money_out/registry.js';
import { clientIp } from '../util/ip.js';

/**
 * Registration is the owner's, behind a password: it tells Safaricom where to post real money's
 * confirmations. Reading and the missed-payments check are for anyone allowed to see money in.
 */
export function moneyInRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get('/status', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await deps.moneyIn.status()); } catch (e) { next(e); } });
  // Phase A: every kind of money in, not only a paybill payment — an express ask, a Bonga
  // redemption, an invoice payment and a standing order all arrive here too.
  r.get('/recent', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await listRequests(deps.db, { type: INCOMING_TYPES, limit: 20 }, deps.config.egressIps)); } catch (e) { next(e); } });
  // Feature 2: payments whose account number names no business, or a customer number nobody holds.
  // Each one carries the reason and enough for the page to offer its own one-click fix.
  r.get('/unmatched', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => {
    try { res.json({ items: await deps.businesses.unmatched() }); } catch (e) { next(e); }
  });
  r.post('/register', requireAuth(deps.db), requireCsrf, requireOwner, requireStepUp(deps.db), async (req, res, next) => {
    try { res.status(202).json(await deps.moneyIn.register({ personId: req.person!.id, ip: clientIp(req) })); } catch (e) { next(e); }
  });
  r.post('/check', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await deps.moneyIn.checkMissed()); } catch (e) { next(e); } });
  return r;
}
