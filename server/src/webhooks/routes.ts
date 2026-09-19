import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner } from '../auth/middleware.js';
import { clientIp } from '../util/ip.js';
import { requireModule } from '../modules/middleware.js';
import { HttpError } from '../util/errors.js';

const urlSchema = z.object({ url: z.string().trim().min(1).max(500) });
const listSchema = z.object({
  state: z.enum(['all', 'pending', 'delivered', 'failed']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * Round 3, phase E: the webhook address, its signing secret, and what has been delivered to it.
 *
 * The owner alone: this is the studio's developer surface, and the secret it hands out is a
 * capability to make this studio's own receiver believe a message came from it.
 */
export function webhookRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'developer'), requireOwner);
  const actor = (req: { person?: { id: string }; headers: Record<string, unknown> }) => ({ personId: req.person!.id, ip: clientIp(req as never) });

  r.get('/', async (_req, res, next) => {
    try { res.json({ webhook: await deps.webhooks.get() }); } catch (e) { next(e); }
  });

  r.put('/', async (req, res, next) => {
    try {
      const b = parse(urlSchema, req.body);
      res.json(await deps.webhooks.save(b.url, actor(req)));
    } catch (e) { next(e); }
  });

  r.post('/secret', async (req, res, next) => {
    try { res.json(await deps.webhooks.rotateSecret(actor(req))); } catch (e) { next(e); }
  });

  r.delete('/', async (req, res, next) => {
    try { await deps.webhooks.remove(actor(req)); res.status(204).end(); } catch (e) { next(e); }
  });

  r.get('/deliveries', async (req, res, next) => {
    try {
      const q = parse(listSchema, req.query);
      res.json({ items: await deps.webhooks.listDeliveries(q) });
    } catch (e) { next(e); }
  });

  r.post('/deliveries/:id/retry', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That delivery does not exist.');
      res.json(await deps.webhooks.retry(id, actor(req)));
    } catch (e) { next(e); }
  });

  return r;
}
