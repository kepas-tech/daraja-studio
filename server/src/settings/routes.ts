import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { Env } from './store.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp as stepUp } from '../auth/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';

const org = z.object({ name: z.string().trim().min(1).max(120), nominatedNumber: z.string().trim().regex(/^254\d{9}$/), notificationPhone: z.string().trim().regex(/^254\d{9}$/) });
const shortcodeSchema = z.object({ shortcode: z.string().trim().regex(/^\d{5,7}$/) });
const mode = z.object({ environment: z.enum(['sandbox','production']), confirmShortcode: z.string().optional() });
const creds = z.object({ consumerKey: z.string().min(1).max(200), consumerSecret: z.string().min(1).max(200) });
const passkey = z.object({ passkey: z.string().min(1).max(200) });
const b2cApi = z.object({ version: z.enum(['auto', 'v1', 'v3']) });
const octetsInRange = (ip: string) => ip.split('.').every((o) => Number(o) <= 255);
const allow = z.object({ allowlist: z.array(z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/).refine(octetsInRange, 'Each number must be 0-255.')).min(1).max(50) });
const pub = z.object({ url: z.string().url() });
const threshold = z.object({ cents: z.number().int().min(0).max(1_000_000_000) });
const categories = z.object({ items: z.array(z.object({ id: z.string().max(40).optional(), name: z.string().max(80), commandId: z.string().max(40) })).max(50) });
const operatorAdd = z.object({ name: z.string().trim().min(1).max(40), operatorPassword: z.string().min(1).max(200).optional(), credential: z.string().min(1).optional(), certPem: z.string().max(16_384).optional() });
const operatorRotate = z.object({ operatorPassword: z.string().min(1).max(200).optional(), credential: z.string().min(1).optional() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function settingsRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireOwner);
  const svc = deps.settingsService;
  const requireStepUp = stepUp(deps.db);
  const a = (req: { person?: { id: string } } & Parameters<typeof clientIp>[0]) => ({ personId: req.person?.id ?? null, ip: clientIp(req) });

  r.param('env', (req, _res, next, value) => {
    if (value !== 'sandbox' && value !== 'production') return next(new HttpError(400, 'invalid_env', 'env must be sandbox or production'));
    next();
  });
  const envParam = (req: { params: { env?: unknown } }) => req.params.env as Env;

  r.get('/', async (_req, res, next) => { try { res.json(await svc.view()); } catch (e) { next(e); } });
  r.put('/org', requireStepUp, async (req, res, next) => { try { await svc.setOrg(parse(org, req.body), a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.put('/environments/:env/shortcode', requireStepUp, async (req, res, next) => { try { const b = parse(shortcodeSchema, req.body); res.json(await svc.setShortcode(envParam(req), b.shortcode, a(req))); } catch (e) { next(e); } });
  r.put('/mode', requireStepUp, async (req, res, next) => { try { const b = parse(mode, req.body); res.json(await svc.setMode(b.environment, b.confirmShortcode, a(req))); } catch (e) { next(e); } });
  r.post('/environments/:env/daraja', requireStepUp, async (req, res, next) => { try { const b = parse(creds, req.body); res.json(await svc.setDarajaCreds(envParam(req), b.consumerKey, b.consumerSecret, a(req))); } catch (e) { next(e); } });
  r.post('/environments/:env/passkey', requireStepUp, async (req, res, next) => { try { await svc.setPasskey(envParam(req), parse(passkey, req.body).passkey, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.put('/environments/:env/b2c-api', requireStepUp, async (req, res, next) => { try { await svc.setB2cApi(envParam(req), parse(b2cApi, req.body).version, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.put('/allowlist', requireStepUp, async (req, res, next) => { try { await svc.setAllowlist(parse(allow, req.body).allowlist, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.put('/send-categories', requireStepUp, async (req, res, next) => { try { res.json({ items: await svc.setSendCategories(parse(categories, req.body).items, a(req)) }); } catch (e) { next(e); } });
  r.put('/approval-threshold', requireStepUp, async (req, res, next) => { try { await svc.setApprovalThreshold(parse(threshold, req.body).cents, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.put('/public-url', requireStepUp, async (req, res, next) => { try { await svc.setPublicUrl(parse(pub, req.body).url, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.post('/public-url/test', async (_req, res, next) => { try { res.json(await svc.testPublicUrl()); } catch (e) { next(e); } });
  r.get('/environments/:env/operators', async (req, res, next) => { try { res.json(await deps.operators.list(envParam(req))); } catch (e) { next(e); } });
  r.post('/environments/:env/operators', requireStepUp, async (req, res, next) => {
    try {
      const b = parse(operatorAdd, req.body);
      const env = envParam(req);
      const { id } = await deps.operators.add(env, { name: b.name, password: b.operatorPassword, certPem: b.certPem, credential: b.credential }, a(req));
      const view = (await deps.operators.list(env)).find((o) => o.id === id);
      res.status(201).json(view);
    } catch (e) { next(e); }
  });
  r.post('/operators/:id/rotate', requireStepUp, async (req, res, next) => { try { const b = parse(operatorRotate, req.body); await deps.operators.rotate(req.params.id as string, { password: b.operatorPassword, credential: b.credential }, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.post('/operators/:id/disable', requireStepUp, async (req, res, next) => { try { await deps.operators.disable(req.params.id as string, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.post('/operators/:id/probe', async (req, res, next) => { try { await deps.operators.probe(req.params.id as string); res.status(204).end(); } catch (e) { next(e); } });
  r.post('/install-secret/reveal', requireStepUp, async (req, res, next) => { try { const secret = await svc.revealInstallSecret(a(req)); res.set('Cache-Control', 'no-store'); res.json({ secret }); } catch (e) { next(e); } });
  return r;
}
