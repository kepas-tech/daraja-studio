import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireHttps } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { requireOrgActive } from '../http/orgActive.js';
import { clientIp } from '../util/ip.js';
import { createQrService } from './service.js';

export function qrRoutes(deps: AppDeps): Router {
  const r = Router();
  const service = createQrService(deps);
  r.use(requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'qr.generate'), requireOrgActive(), requireHttps(deps.config));
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  r.get('/', async (_req, res, next) => {
    try { res.json(await service.details()); } catch (e) { next(e); }
  });
  r.post('/', async (req, res, next) => {
    try { res.json(await service.generate(req.body, { personId: req.person!.id, ip: clientIp(req) })); }
    catch (e) { next(e); }
  });
  return r;
}
