import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';

/** Round 3, phase D-5: the case file on one payment. Reading needs the same permission as the
 * payment's own page; opening, recording and closing are the new `cases.manage`. */
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const openSchema = z.object({ title: z.string().trim().min(1).max(120) });
const noteSchema = z.object({ note: z.string().trim().min(1).max(1000) });
const closeSchema = z.object({ outcome: z.string().trim().min(1).max(500) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

const paymentId = (req: { params: unknown }): string => {
  const id = String((req.params as { id?: string }).id ?? '');
  if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That payment does not exist.');
  return id;
};

/** Mounted at `/api/requests/:id/case`, so `:id` is the payment the case belongs to. */
export function requestCaseRoutes(deps: AppDeps): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth(deps.db), requireCsrf);
  r.get('/', requirePermission(deps.db, 'lookup.view'), async (req, res, next) => {
    try { res.json(await deps.cases.forRequest(paymentId(req))); } catch (e) { next(e); }
  });
  r.post('/', requirePermission(deps.db, 'cases.manage'), async (req, res, next) => {
    try {
      const b = parse(openSchema, req.body);
      res.status(201).json(await deps.cases.open(paymentId(req), b.title, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  return r;
}

/** What is done to a case once it exists: a note, and the close. */
export function caseRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'cases.manage'));
  r.post('/:id/notes', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That case does not exist.');
      const b = parse(noteSchema, req.body);
      res.json(await deps.cases.addNote(id, b.note, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  r.post('/:id/close', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That case does not exist.');
      const b = parse(closeSchema, req.body);
      res.json(await deps.cases.close(id, b.outcome, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  return r;
}
