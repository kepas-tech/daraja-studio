import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner } from '../auth/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { KEY_ROLES } from './service.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(['operator', 'viewer', 'approver', 'forwarder']),
});

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

/**
 * Round 3, phase E. Only the owner manages keys, and only from a signed-in session — a key can
 * never manage keys, so a leaked one cannot mint its successor. The secret leaves the server once,
 * in the create and rotate answers, and no read ever carries it again.
 */
export function apiKeyRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireOwner);

  r.get('/', async (_req, res, next) => {
    try { res.json({ items: await deps.apiKeys.list(), roles: KEY_ROLES }); } catch (e) { next(e); }
  });

  r.post('/', requireCsrf, async (req, res, next) => {
    try {
      const b = parse(createSchema, req.body);
      res.status(201).json(await deps.apiKeys.create(b, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });

  r.post('/:id/rotate', requireCsrf, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That key does not exist.');
      res.status(201).json(await deps.apiKeys.rotate(id, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });

  r.post('/:id/revoke', requireCsrf, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That key does not exist.');
      res.json(await deps.apiKeys.revoke(id, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });

  return r;
}
