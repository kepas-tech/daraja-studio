import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner } from '../auth/middleware.js';
import { clientIp } from '../util/ip.js';
import { requireModule } from '../modules/middleware.js';
import { HttpError } from '../util/errors.js';
import { KEY_ROLES } from './service.js';
import { checkWebhookUrl } from '../webhooks/signing.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(['operator', 'viewer', 'approver', 'forwarder', 'collector']),
  /** Step six, part five: a key can be given its own webhook address as it is made. */
  webhookUrl: z.string().trim().max(500).optional(),
});
const webhookUrlSchema = z.object({ url: z.string().trim().min(1).max(500) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
function keyId(req: Request): string {
  const id = String(req.params.id);
  if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That key does not exist.');
  return id;
}

/**
 * Round 3, phase E. Only the owner manages keys, and only from a signed-in session — a key can
 * never manage keys, so a leaked one cannot mint its successor. The secret leaves the server once,
 * in the create and rotate answers, and no read ever carries it again.
 *
 * Step six, part five: a key is also where a person names the address its payments' notices go to,
 * in the same breath as the key itself. The address and its secret belong to the key, so one
 * receiver can be set up, rotated or stopped without touching another.
 */
export function apiKeyRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireModule(deps.modules, 'developer'), requireOwner);
  const actor = (req: Request) => ({ personId: req.person!.id, ip: clientIp(req) });

  r.get('/', async (_req, res, next) => {
    try {
      const items = await deps.apiKeys.list();
      const held = await deps.webhooks.heldByKeys();
      res.json({
        items: items.map((k) => ({ ...k, webhook: held.get(k.id) ?? null })),
        roles: KEY_ROLES,
        // The address a key without one of its own falls back to, so the page can say where its
        // notices actually go rather than only what the key holds itself.
        organisation: await deps.webhooks.get(),
      });
    } catch (e) { next(e); }
  });

  /**
   * A URL a person typed, checked before anything is written; and nothing at all for an empty field.
   * The address itself is saved by the webhook service, which checks it again on its own account.
   */
  function checkedUrl(raw: string | undefined): string | null {
    if (raw === undefined) return null;
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const checked = checkWebhookUrl(trimmed);
    if (!checked.ok) throw new HttpError(400, 'bad_url', checked.reason);
    return trimmed;
  }

  r.post('/', requireCsrf, async (req, res, next) => {
    try {
      const b = parse(createSchema, req.body);
      const url = checkedUrl(b.webhookUrl);
      const created = await deps.apiKeys.create({ name: b.name, role: b.role }, actor(req));
      const webhook = url ? await deps.webhooks.forKey(created.key.id).save(url, actor(req)) : null;
      res.status(201).json({ ...created, webhook });
    } catch (e) { next(e); }
  });

  r.post('/:id/rotate', requireCsrf, async (req, res, next) => {
    try {
      const id = keyId(req);
      const created = await deps.apiKeys.rotate(id, actor(req));
      // The receiver follows the replacement: the replaced key's own address is copied to the new
      // key, address and secret together, so replacing a key never reconfigures a receiver.
      await deps.webhooks.copyForKey(id, created.key.id, actor(req));
      res.status(201).json(created);
    } catch (e) { next(e); }
  });

  r.post('/:id/revoke', requireCsrf, async (req, res, next) => {
    try {
      const id = keyId(req);
      res.json(await deps.apiKeys.revoke(id, actor(req)));
    } catch (e) { next(e); }
  });

  r.put('/:id/webhook', requireCsrf, async (req, res, next) => {
    try {
      const b = parse(webhookUrlSchema, req.body);
      res.json(await deps.webhooks.forKey(keyId(req)).save(b.url, actor(req)));
    } catch (e) { next(e); }
  });

  r.post('/:id/webhook/secret', requireCsrf, async (req, res, next) => {
    try { res.json(await deps.webhooks.forKey(keyId(req)).rotateSecret(actor(req))); } catch (e) { next(e); }
  });

  r.delete('/:id/webhook', requireCsrf, async (req, res, next) => {
    try { await deps.webhooks.forKey(keyId(req)).remove(actor(req)); res.status(204).end(); } catch (e) { next(e); }
  });

  return r;
}
