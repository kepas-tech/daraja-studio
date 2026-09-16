import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { HttpError } from '../util/errors.js';
import { createNotificationsService } from './service.js';

const listQuery = z.object({
  filter: z.enum(['all', 'unread']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

/**
 * Feature 4. Any signed-in person may read and clear the inbox: it is the studio's own activity, and
 * the plan names no permission for it. Every write is idempotent, so a double press changes nothing.
 */
export function notificationRoutes(deps: AppDeps): Router {
  const r = Router();
  const notifications = createNotificationsService({ db: deps.db, events: deps.events });
  r.use(requireAuth(deps.db), requireCsrf);

  r.get('/', async (req, res, next) => {
    try { res.json(await notifications.list(parse(listQuery, req.query))); } catch (e) { next(e); }
  });

  r.get('/count', async (_req, res, next) => {
    try { res.json({ unread: await notifications.count() }); } catch (e) { next(e); }
  });

  r.post('/read-all', async (_req, res, next) => {
    try { res.json({ read: await notifications.markAllRead() }); } catch (e) { next(e); }
  });

  r.post('/:id/read', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That notification does not exist.');
      await notifications.markRead(id);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
