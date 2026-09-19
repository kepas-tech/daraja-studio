import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { requireModule } from '../modules/middleware.js';
import { audit } from '../audit/log.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { sendCsv, shillings, toCsv, todayNairobi } from '../export/csv.js';
import { createReportsService } from './service.js';

/**
 * Feature 6. The page and its spreadsheet, both read-only: no route here writes a row, and none
 * touches Safaricom. `lookup.view` guards the numbers because History already trusts it with both
 * directions; the file takes `history.export`, the same key the History and Invoices files take.
 */

/** The windows the page offers. Anything else is refused in plain English, never defaulted. */
const DAY_CHOICES = [7, 30, 90];
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** One place reads the query, so the page and the file can never disagree about what it means. */
function parseQuery(raw: unknown): { days: number; businessId: string | null } {
  const q = (raw ?? {}) as Record<string, unknown>;
  let days = 7;
  if (q.days !== undefined && q.days !== '') {
    const n = Number(q.days);
    if (!Number.isInteger(n) || !DAY_CHOICES.includes(n)) {
      throw new HttpError(400, 'bad_days', 'Choose 7, 30 or 90 days.');
    }
    days = n;
  }
  let businessId: string | null = null;
  if (q.businessId !== undefined && q.businessId !== '') {
    if (typeof q.businessId !== 'string' || !isUuid(q.businessId)) {
      throw new HttpError(400, 'bad_business', 'Pick a business from the list.');
    }
    businessId = q.businessId;
  }
  return { days, businessId };
}

/** The spreadsheet columns, in the order the page reads: day, in, out, then how they ended. */
const CSV_COLUMNS = ['Day', 'Money in', 'Payments in', 'Money out', 'Payments out', 'Paid', 'Failed', 'Needs a check'];

export function reportsRoutes(deps: AppDeps): Router {
  const r = Router();
  const reports = createReportsService({ db: deps.db });
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'reports'));

  r.get('/', requirePermission(deps.db, 'lookup.view'), async (req, res, next) => {
    try { res.json(await reports.view(parseQuery(req.query))); } catch (e) { next(e); }
  });

  // The last 24 hours, for the strip on Home. One grouped query, no window to choose.
  r.get('/summary', requirePermission(deps.db, 'lookup.view'), async (_req, res, next) => {
    try { res.json(await reports.summary()); } catch (e) { next(e); }
  });

  // The same numbers the page shows, as a file. The table is the product here, so the file is the
  // per-day table with one line per day, zeros included.
  r.get('/export.csv', requirePermission(deps.db, 'history.export'), async (req, res, next) => {
    try {
      const q = parseQuery(req.query);
      const view = await reports.view(q);
      // Parity with History's export: one audit row naming what was asked for, never the numbers.
      await audit(deps.db, {
        personId: req.person!.id, ip: clientIp(req), action: 'reports.exported',
        after: { days: q.days, businessId: q.businessId },
      });
      const rows = view.days.map((d) => [
        d.day, shillings(d.inCents), d.inCount, shillings(d.outCents), d.outCount,
        d.completed, d.failed, d.unknown,
      ]);
      sendCsv(res, 'reports-' + todayNairobi() + '.csv', toCsv(CSV_COLUMNS, rows));
    } catch (e) { next(e); }
  });

  return r;
}
