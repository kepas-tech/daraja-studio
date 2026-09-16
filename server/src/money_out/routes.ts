import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireStepUp } from '../auth/middleware.js';
import { requirePermission, assertPermission, personPermissions } from '../permissions/middleware.js';
import { requireMoneyReady } from './ready.js';
import { getRequest, listRequests, type RequestView } from './reads.js';
import { audit } from '../audit/log.js';
import { EXPORT_MAX, nairobiStamp, sendCsv, shillings, toCsv, todayNairobi } from '../export/csv.js';
import { statusLabel, whatLabel } from '../export/labels.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { KINDS } from './registry.js';

const sendPhone = z.object({
  phone: z.string().trim().min(1).max(20),
  amountCents: z.number().int().positive(),
  // The business's own category name (settings/categories.ts) decides the Safaricom command; a
  // bare commandId is still accepted for callers that have no category.
  category: z.string().trim().min(1).max(40).optional(),
  commandId: z.enum(['BusinessPayment', 'SalaryPayment', 'PromotionPayment']).default('BusinessPayment'),
  remarks: z.string().trim().max(100).optional(),
  occasion: z.string().trim().max(100).optional(),
  confirmDuplicate: z.boolean().optional(),
  // Feature 1: a saved phone contact the operator picked on the review screen. The phone above is
  // still the number that will be dialled; the service refuses the pair when they disagree.
  contactId: z.string().uuid().optional(),
  // Feature 2: which business this send belongs to. Optional, so nothing that worked before changes.
  businessId: z.string().uuid().optional(),
});

// A YYYY-MM-DD that fails to round-trip through Date (2026-02-30, 2026-13-45, ...) is calendar-
// invalid, not just malformed — the regex alone lets it through to a Postgres ::date cast, which
// 500s instead of the plain-English 400. An out-of-range month/day/year
// makes `new Date(...)` an Invalid Date, and `.toISOString()` on that throws — the predicate must
// check `getTime()` first so a throw never escapes zod's `.refine`.
const isRealDay = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, { message: 'Enter a real date.' });
const listSchema = z.object({
  type: z.string().optional(), status: z.enum(['pending', 'sent', 'completed', 'failed', 'unknown', 'cancelled', 'rejected', 'awaiting_approval']).optional(),
  from: dayString.optional(), to: dayString.optional(),
  q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(200).optional(),
  // Feature 2: History and Money in narrow by business, and a customer link narrows to one customer.
  businessId: z.string().uuid().optional(), customerId: z.string().uuid().optional(),
}).refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'The end date must be on or after the start date.', path: ['to'] });
const checkedSchema = z.object({ note: z.string().trim().min(1).max(500) });

/** Feature 3: the columns an exported History carries, in the order the page reads. */
const HISTORY_COLUMNS = ['When', 'What', 'To', 'Name', 'Business', 'Amount', 'Status', 'Receipt', 'Note', 'Who made it'];

/**
 * One History row as file cells. The name is the owner's own label first (the saved contact, then
 * the customer), Safaricom's registered name only when the studio has nothing better.
 */
function historyRow(r: RequestView): unknown[] {
  return [
    nairobiStamp(r.createdAt),
    whatLabel(r),
    r.recipient.value ?? '',
    r.contactName ?? r.customerName ?? r.recipient.name ?? '',
    r.businessName ?? '',
    shillings(r.amountCents),
    statusLabel(r.status),
    r.receipt ?? '',
    r.remarks ?? '',
    r.createdBy?.displayName ?? '',
  ];
}
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const nameCheckSchema = z.object({ phone: z.string().trim().min(1).max(20) });
const lookupSchema = z.object({ receipt: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'An M-Pesa receipt is 10 letters and numbers, like RI6BZTPXNM.') });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function sendRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get('/categories', requireAuth(deps.db), requireCsrf, async (_req, res, next) => { try { res.json({ items: await deps.settingsService.getSendCategories() }); } catch (e) { next(e); } });
  // Asked on the review step, before the password. Same gate as the send itself so nobody can
  // use Studio as a phone-number directory without being able to send.
  r.post('/name-check', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'send.phone'), requireMoneyReady(deps), async (req, res, next) => {
    try { res.json(await deps.moneyOut.nameCheck(parse(nameCheckSchema, req.body).phone)); } catch (e) { next(e); }
  });
  r.post('/phone', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'send.phone'), requireMoneyReady(deps), requireStepUp(deps.db), async (req, res, next) => {
    try {
      const b = parse(sendPhone, req.body);
      const v = await deps.moneyOut.send(b, { personId: req.person!.id, ip: clientIp(req) });
      res.status(201).json(v);
    } catch (e) { next(e); }
  });
  return r;
}

export function requestRoutes(deps: AppDeps): Router {
  const r = Router();
  // Session + CSRF are shared by every route here; the permission key is not — `/check` can
  // actually move a poll budget and hit Safaricom, so it needs `send.phone`, not the
  // read-only `lookup.view` the other three routes use.
  r.use(requireAuth(deps.db), requireCsrf);
  r.get('/', requirePermission(deps.db, 'lookup.view'), async (req, res, next) => {
    try {
      const qy = parse(listSchema, req.query);
      res.json(await listRequests(deps.db, { ...qy, type: qy.type ? qy.type.split(',').map((s) => s.trim()).filter(Boolean) : undefined }, deps.config.egressIps));
    } catch (e) { next(e); }
  });
  // Feature 3: the rows the page has, as a file. `listRequests` owns what a filter means, so the
  // file and the screen can never disagree; only the paging is dropped and the page's own cap is
  // replaced by the export's. Registered before /:id so "export.csv" is never read as an id.
  r.get('/export.csv', requirePermission(deps.db, 'history.export'), async (req, res, next) => {
    try {
      const qy = parse(listSchema, req.query);
      const filter = { ...qy, type: qy.type ? qy.type.split(',').map((s) => s.trim()).filter(Boolean) : undefined };
      const { items } = await listRequests(deps.db, { ...filter, limit: EXPORT_MAX }, deps.config.egressIps);
      // What the person asked for, never what came back — and never the search text itself, which
      // is often a phone number.
      await audit(deps.db, {
        personId: req.person!.id, ip: clientIp(req), action: 'history.exported',
        after: {
          type: filter.type ?? null, status: qy.status ?? null, from: qy.from ?? null, to: qy.to ?? null,
          businessId: qy.businessId ?? null, customerId: qy.customerId ?? null, searched: Boolean(qy.q),
        },
      });
      sendCsv(res, `history-${todayNairobi()}.csv`, toCsv(HISTORY_COLUMNS, items.map(historyRow)));
    } catch (e) { next(e); }
  });
  r.get('/:id', requirePermission(deps.db, 'lookup.view'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That request does not exist.');
      const v = await getRequest(deps.db, id, deps.config.egressIps);
      if (!v) throw new HttpError(404, 'not_found', 'That request does not exist.');
      res.json(v);
    } catch (e) { next(e); }
  });
  r.post('/:id/checked', requirePermission(deps.db, 'lookup.view'), requireStepUp(deps.db), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That request does not exist.');
      const b = parse(checkedSchema, req.body);
      res.json(await deps.moneyOut.markChecked(id, b.note, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  // B0: the permission is the kind's, not always the phone's. `pollOne` already accepts every
  // money type, so leaving `send.phone` here would have let anyone who may send to a phone poll a
  // paybill payment or a reversal, and would have refused someone permitted only for those. The
  // row is read inside the organisation first, so tenant isolation decides existence before
  // permission decides access.
  r.post('/:id/check', requireMoneyReady(deps), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That request does not exist.');
      const [row] = await deps.db.query<{ type: string }>('SELECT type FROM requests WHERE id=$1', [id]);
      if (!row) throw new HttpError(404, 'not_found', 'That request does not exist.');
      const kind = KINDS[row.type];
      if (!kind) throw new HttpError(404, 'not_found', 'That request does not exist.');
      await assertPermission(deps.db, req.person!, kind.permission);
      const { queryId } = await deps.moneyOut.pollOne(id);
      res.status(202).json({ requestId: queryId });
    } catch (e) { next(e); }
  });
  return r;
}

export function balanceRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'balances.view'));
  r.get('/latest', async (_req, res, next) => {
    try {
      const rows = await deps.db.query<{ working_cents: string | null; utility_cents: string | null; charges_paid_cents: string | null; queried_at: Date }>(
        'SELECT working_cents, utility_cents, charges_paid_cents, queried_at FROM balances ORDER BY queried_at DESC LIMIT 1');
      const b = rows[0];
      res.json(b ? {
        workingCents: b.working_cents === null ? null : Number(b.working_cents),
        utilityCents: b.utility_cents === null ? null : Number(b.utility_cents),
        chargesPaidCents: b.charges_paid_cents === null ? null : Number(b.charges_paid_cents),
        queriedAt: b.queried_at.toISOString(),
      } : null);
    } catch (e) { next(e); }
  });
  r.post('/refresh', requireMoneyReady(deps), async (req, res, next) => {
    try { res.status(202).json(await deps.moneyOut.refreshBalance({ personId: req.person!.id, ip: clientIp(req) })); } catch (e) { next(e); }
  });
  return r;
}

export function lookupRoutes(deps: AppDeps): Router {
  const r = Router();
  r.post('/', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'lookup.view'), requireMoneyReady(deps), async (req, res, next) => {
    try {
      const b = parse(lookupSchema, req.body);
      res.status(202).json(await deps.moneyOut.lookup(b.receipt, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  return r;
}

/**
 * M4. The list and both decisions need `send.approve`; the count is for the menu badge and any
 * signed-in person may read it. Release takes the password, as any send does; refuse does not,
 * because nothing moves.
 */
export function approvalRoutes(deps: AppDeps): Router {
  const r = Router();
  const refuseSchema = z.object({ reason: z.string().trim().min(1).max(200) });
  r.get('/', requireAuth(deps.db), requirePermission(deps.db, 'send.approve'), async (_req, res, next) => { try { res.json(await deps.moneyOut.listAwaiting()); } catch (e) { next(e); } });
  r.get('/count', requireAuth(deps.db), async (_req, res, next) => {
    try {
      // `enabled` lets the menu show Waiting for approval only while approvals are on (or something still waits).
      const [row] = await deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM requests WHERE status='awaiting_approval'`);
      const enabled = (Number((await deps.settings.get('send.approvalThresholdCents')) ?? 0) || 0) > 0;
      res.json({ count: row.n, enabled });
    } catch (e) { next(e); }
  });
  r.post('/:id/release', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'send.approve'), requireMoneyReady(deps), requireStepUp(deps.db), async (req, res, next) => {
    try {
      if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', 'That request does not exist.');
      res.status(201).json(await deps.moneyOut.release(String(req.params.id), { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  r.post('/:id/refuse', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'send.approve'), async (req, res, next) => {
    try {
      if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', 'That request does not exist.');
      const b = parse(refuseSchema, req.body);
      res.json(await deps.moneyOut.refuse(String(req.params.id), b.reason, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  return r;
}

/**
 * Feature 5: the Waiting page. Reads only — Release, Refuse, "Check with Safaricom" and Mark as
 * checked keep their own routes and gates. `canDecide` is the release route's own rule (the owner,
 * or `send.approve`), so the page never draws a button that route would refuse.
 */
export function waitingRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get('/', requireAuth(deps.db), requirePermission(deps.db, 'lookup.view'), async (req, res, next) => {
    try {
      const person = req.person!;
      const canDecide = person.is_owner || (await personPermissions(deps.db, person.id)).includes('send.approve');
      res.json(await deps.moneyOut.listWaiting(canDecide));
    } catch (e) { next(e); }
  });
  r.get('/count', requireAuth(deps.db), async (_req, res, next) => {
    try { res.json({ badge: await deps.moneyOut.waitingBadge() }); } catch (e) { next(e); }
  });
  return r;
}

/** M5. Check is free of side effects; create and retry move money, so they take the password. */
export function bulkRoutes(deps: AppDeps): Router {
  const r = Router();
  const text = z.object({ text: z.string().max(200_000) });
  const create = text.extend({ category: z.string().trim().min(1).max(40).optional(), businessId: z.string().uuid().optional() });
  r.post('/check', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'bulk.send'), async (req, res, next) => { try { res.json(deps.bulk.check(parse(text, req.body).text)); } catch (e) { next(e); } });
  r.post('/', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'bulk.send'), requireMoneyReady(deps), requireStepUp(deps.db), async (req, res, next) => {
    try { const b = parse(create, req.body); res.status(201).json(await deps.bulk.create(b.text, b.category, { personId: req.person!.id, ip: clientIp(req) }, b.businessId)); } catch (e) { next(e); }
  });
  r.get('/', requireAuth(deps.db), requirePermission(deps.db, 'bulk.send'), async (_req, res, next) => { try { res.json({ items: await deps.bulk.list() }); } catch (e) { next(e); } });
  r.get('/:id', requireAuth(deps.db), requirePermission(deps.db, 'bulk.send'), async (req, res, next) => {
    try { if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', 'That batch does not exist.'); res.json(await deps.bulk.get(String(req.params.id))); } catch (e) { next(e); }
  });
  r.post('/:id/retry', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'bulk.send'), requireMoneyReady(deps), requireStepUp(deps.db), async (req, res, next) => {
    try { if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', 'That batch does not exist.'); res.json(await deps.bulk.retry(String(req.params.id), { personId: req.person!.id, ip: clientIp(req) })); } catch (e) { next(e); }
  });
  return r;
}
