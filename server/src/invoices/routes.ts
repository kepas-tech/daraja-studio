import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, { message: 'Enter a real date.' });
const optIn = z.object({ email: z.string().trim().email().max(120), officialContact: z.string().trim().min(1).max(20), sendReminders: z.boolean(), logo: z.string().max(200_000).optional() });
const invoice = z.object({
  customerName: z.string().trim().min(1).max(80), customerPhone: z.string().trim().min(1).max(20), invoiceName: z.string().trim().min(1).max(80),
  accountReference: z.string().trim().min(1).max(20), billedPeriod: z.string().trim().min(1).max(40), dueDate: day, amountCents: z.number().int().positive(),
  items: z.array(z.object({ name: z.string().trim().min(1).max(80), amountCents: z.number().int().positive() })).max(50).optional(),
});
const bulkText = z.object({ text: z.string().max(400_000) });
const cancelMany = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });
const payment = z.object({ paymentDate: day, amountCents: z.number().int().positive(), reference: z.string().trim().min(1).max(40), payer: z.string().trim().max(80).default('') });
const listQuery = z.object({ filter: z.enum(['open', 'paid', 'overdue', 'cancelled', 'all']).default('open'), q: z.string().trim().max(60).optional() });
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * Opting in is the owner's, behind a password: it tells Safaricom where to post payments. Sending,
 * cancelling and recording take `invoices.manage`; nothing here moves money out, so no step-up.
 */
export function invoiceRoutes(deps: AppDeps): Router {
  const r = Router();
  const a = (req: Parameters<typeof clientIp>[0] & { person?: { id: string } }) => ({ personId: req.person!.id, ip: clientIp(req) });
  const can = requirePermission(deps.db, 'invoices.manage');
  r.get('/settings', requireAuth(deps.db), can, async (_req, res, next) => { try { res.json(await deps.invoices.settings()); } catch (e) { next(e); } });
  // 202: the Safaricom call runs after this reply; the page reads its outcome from GET /settings.
  r.post('/opt-in', requireAuth(deps.db), requireCsrf, requireOwner, requireStepUp(deps.db), async (req, res, next) => { try { res.status(202).json(await deps.invoices.optIn(parse(optIn, req.body), a(req))); } catch (e) { next(e); } });
  r.get('/', requireAuth(deps.db), can, async (req, res, next) => { try { const q = parse(listQuery, req.query); res.json({ items: await deps.invoices.list(q.filter, q.q) }); } catch (e) { next(e); } });
  r.get('/unmatched', requireAuth(deps.db), can, async (_req, res, next) => { try { res.json({ items: await deps.invoices.unmatched() }); } catch (e) { next(e); } });
  r.post('/', requireAuth(deps.db), requireCsrf, can, async (req, res, next) => { try { res.status(201).json(await deps.invoices.create(parse(invoice, req.body), a(req))); } catch (e) { next(e); } });
  r.post('/bulk/check', requireAuth(deps.db), requireCsrf, can, async (req, res, next) => { try { res.json(deps.invoices.checkBulk(parse(bulkText, req.body).text)); } catch (e) { next(e); } });
  r.post('/bulk', requireAuth(deps.db), requireCsrf, can, async (req, res, next) => { try { res.status(201).json(await deps.invoices.createBulk(parse(bulkText, req.body).text, a(req))); } catch (e) { next(e); } });
  r.post('/cancel', requireAuth(deps.db), requireCsrf, can, async (req, res, next) => { try { res.json({ cancelled: await deps.invoices.cancel(parse(cancelMany, req.body).ids, a(req)) }); } catch (e) { next(e); } });
  r.get('/:id', requireAuth(deps.db), can, async (req, res, next) => { try { if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', 'That invoice does not exist.'); res.json(await deps.invoices.get(String(req.params.id))); } catch (e) { next(e); } });
  r.post('/:id/cancel', requireAuth(deps.db), requireCsrf, can, async (req, res, next) => { try { if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', 'That invoice does not exist.'); await deps.invoices.cancel([String(req.params.id)], a(req)); res.json(await deps.invoices.get(String(req.params.id))); } catch (e) { next(e); } });
  r.post('/:id/payment', requireAuth(deps.db), requireCsrf, can, async (req, res, next) => { try { if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', 'That invoice does not exist.'); res.json(await deps.invoices.recordPayment(String(req.params.id), parse(payment, req.body), a(req))); } catch (e) { next(e); } });
  return r;
}
