import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireStepUp } from '../auth/middleware.js';
import { assertPermission } from '../permissions/middleware.js';
import { requireModule } from '../modules/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { EVERY, WEEKEND_RULES } from './timetable.js';
import { MODULE_KEY, type LineInput } from './service.js';

const isRealDay = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, { message: 'Enter a real date.' });
const timetable = {
  every: z.enum(EVERY),
  weekday: z.number().int().min(0).max(6).default(0),
  dayOfMonth: z.number().int().min(1).max(31).default(1),
  hour: z.number().int().min(0).max(23).default(9),
  weekendRule: z.enum(WEEKEND_RULES).default('on_day'),
  startOn: day,
  endOn: day.nullable().optional(),
};
const scheduleBody = z.object({
  name: z.string().trim().min(1).max(60),
  ...timetable,
  phoneCommand: z.enum(['SalaryPayment', 'BusinessPayment']).default('SalaryPayment'),
  lines: z.array(z.object({ contactId: z.string().uuid(), amountCents: z.number().int().positive(), note: z.string().trim().max(100).optional() })).min(1).max(200),
  // The warning has to be accepted: this pays on its own, on every date, until it is stopped.
  accepted: z.literal(true, { message: 'Accept the warning first: this pays on its own until you stop it.' }),
});
const previewBody = z.object(timetable);
const stopBody = z.object({ name: z.string().trim().min(1).max(60) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
const actor = (req: Request) => ({ personId: req.person!.id, ip: clientIp(req) });
const wrap = (fn: (req: Request) => Promise<unknown>, status = 200): RequestHandler => async (req, res, next) => {
  try { res.status(status).json(await fn(req)); } catch (e) { next(e); }
};

export function scheduleRoutes(deps: AppDeps): Router {
  const r = Router();
  const svc = deps.schedules;
  const on = requireModule(deps.modules, MODULE_KEY);
  const read = [requireAuth(deps.db), on];
  const write = [requireAuth(deps.db), requireCsrf, on];

  /** Setting up, changing or resuming pay lines needs the send permission for every kind of line. */
  async function mayPay(req: Request, lines: LineInput[]): Promise<void> {
    for (const key of await svc.permissionsFor(lines)) await assertPermission(deps.db, req.person!, key, req.apiKey?.permissions);
  }
  /** Pausing and stopping are for anybody who may pay out at all: the safe direction is never locked away. */
  async function mayManage(req: Request): Promise<void> {
    if (req.person!.is_owner) return;
    const keys = ['send.phone', 'pay.paybill', 'pay.till'] as const;
    for (const key of keys) {
      try { await assertPermission(deps.db, req.person!, key, req.apiKey?.permissions); return; } catch { /* try the next */ }
    }
    throw new HttpError(403, 'no_permission', 'You do not have permission for this. Ask the owner.', { permission: 'send.phone' });
  }
  const linesOf = async (id: string): Promise<LineInput[]> => (await svc.get(id)).lines.map((l) => ({ contactId: l.contactId, amountCents: l.amountCents }));

  r.get('/', ...read, wrap(async () => ({ items: await svc.list() })));
  r.get('/summary', ...read, wrap(() => svc.summary()));
  r.post('/preview', ...write, wrap(async (req) => svc.preview(parse(previewBody, req.body))));
  r.get('/runs/:runId', ...read, wrap((req) => svc.run(String(req.params.runId))));
  r.post('/runs/:runId/retry', ...write, requireStepUp(deps.db), wrap(async (req) => {
    const run = await svc.run(String(req.params.runId));
    await mayPay(req, await linesOf(run.scheduleId));
    return svc.retry(run.id, actor(req));
  }));
  r.get('/:id', ...read, wrap((req) => svc.get(String(req.params.id))));
  r.get('/:id/runs', ...read, wrap(async (req) => ({ items: await svc.runs(String(req.params.id)) })));
  r.post('/', ...write, requireStepUp(deps.db), wrap(async (req) => {
    const b = parse(scheduleBody, req.body);
    await mayPay(req, b.lines);
    return svc.create(b, actor(req));
  }, 201));
  r.put('/:id', ...write, requireStepUp(deps.db), wrap(async (req) => {
    const b = parse(scheduleBody, req.body);
    await mayPay(req, b.lines);
    return svc.update(String(req.params.id), b, actor(req));
  }));
  r.post('/:id/pause', ...write, wrap(async (req) => { await mayManage(req); return svc.pause(String(req.params.id), actor(req)); }));
  r.post('/:id/resume', ...write, requireStepUp(deps.db), wrap(async (req) => {
    await mayPay(req, await linesOf(String(req.params.id)));
    return svc.resume(String(req.params.id), actor(req));
  }));
  r.post('/:id/stop', ...write, requireStepUp(deps.db), wrap(async (req) => {
    await mayManage(req);
    return svc.stop(String(req.params.id), parse(stopBody, req.body).name, actor(req));
  }));
  return r;
}
