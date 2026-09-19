import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { createPushService, type PushService } from './service.js';
import { requireModule } from '../modules/middleware.js';

const subscribeBody = z.object({
  // A push endpoint is the address of this browser at its push service. Only https, and the same
  // generous length limit the browser itself uses.
  endpoint: z.string().trim().min(1).max(2048).refine((s) => s.startsWith('https://'), 'A push address is an https address.'),
  keys: z.object({
    p256dh: z.string().trim().min(20).max(200),
    auth: z.string().trim().min(10).max(100),
  }),
});
const unsubscribeBody = z.object({ endpoint: z.string().trim().min(1).max(2048) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

/** Nothing to press when the deployment has no keys; the page hides the button on the same fact. */
const pushOff = () => new HttpError(409, 'push_off', 'Notifications are not set up on this server. Ask the person who installed Studio to add the push keys.');

/**
 * Feature 12, second half. The inbox has no permission of its own, so neither has this: any
 * signed-in person turns notifications on for their own devices and nobody else's. The endpoint
 * and its keys never appear in an answer, an audit row or a log.
 */
export function pushRoutes(deps: AppDeps): Router {
  const r = Router();
  const push: PushService = deps.push ?? createPushService({ db: deps.db, vapid: deps.config.vapid });
  // Step one: a nudge on a device belongs with the inbox it comes from.
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'notifications'));

  r.get('/key', (_req, res) => {
    res.json({ configured: push.configured(), publicKey: push.publicKey() });
  });

  r.post('/subscribe', async (req, res, next) => {
    try {
      if (!push.configured()) throw pushOff();
      const b = parse(subscribeBody, req.body);
      const person = req.person!;
      const { devices } = await push.subscribe({ personId: person.id, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, ip: clientIp(req) });
      res.json({ devices });
    } catch (e) { next(e); }
  });

  r.post('/unsubscribe', async (req, res, next) => {
    try {
      const b = parse(unsubscribeBody, req.body);
      await push.unsubscribe({ personId: req.person!.id, endpoint: b.endpoint, ip: clientIp(req) });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/test', async (req, res, next) => {
    try {
      if (!push.configured()) throw pushOff();
      res.json(await push.sendTest({ personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });

  return r;
}
