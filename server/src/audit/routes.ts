import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { HttpError } from '../util/errors.js';

/** One row of the audit log, as the page reads it. `before` and `after` are the stored JSON. */
export interface AuditRowView {
  id: string; at: string; action: string;
  /** null for a row nobody signed: a job, a callback or a migration. */
  person: { id: string; displayName: string } | null;
  target: string | null; before: unknown; after: unknown; ip: string | null;
}

export interface AuditPage { items: AuditRowView[]; nextCursor: string | null }

interface Row {
  id: string; at: Date; at_cursor: string; action: string;
  person_id: string | null; person_name: string | null;
  target: string | null; before_json: unknown; after_json: unknown; ip: string | null;
}

/**
 * Feature 10. The audit log is the one table nobody edits — 001_init.sql's trigger refuses every
 * UPDATE and DELETE — so this module only ever reads it. Every statement below is a SELECT.
 */
const SELECT = `SELECT a.id::text AS id, a.at,
  to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_cursor,
  a.action, a.person_id, p.display_name AS person_name, a.target,
  a.before_json, a.after_json, a.ip
  FROM audit_log a LEFT JOIN people p ON p.id = a.person_id`;

function toView(r: Row): AuditRowView {
  return {
    id: r.id, at: r.at.toISOString(), action: r.action,
    person: r.person_id ? { id: r.person_id, displayName: r.person_name ?? '' } : null,
    target: r.target, before: r.before_json ?? null, after: r.after_json ?? null, ip: r.ip,
  };
}

// The same shape reads.ts builds its own cursor from: a UTC, microsecond-exact text rendering of
// the timestamp. The id half is audit_log's bigserial, so it is digits — not a uuid, which is what
// History's cursor carries. A cursor that does not match this shape is refused as a 400 before it
// ever reaches a SQL cast, which would otherwise 500 on the attacker-controlled literal.
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_RE = /^[0-9]{1,19}$/;
// 19 digits is not enough on its own: 9999999999999999999 matches the shape and overflows int8,
// which would turn a hostile cursor into a 500 on the cast. The value must also fit.
const MAX_BIGINT = 9223372036854775807n;

const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(c: string): { at: string; id: string } | null {
  let s: string;
  try { s = Buffer.from(c, 'base64url').toString('utf8'); } catch { return null; }
  const i = s.indexOf('|');
  if (i < 0) return null;
  const at = s.slice(0, i); const id = s.slice(i + 1);
  if (!CURSOR_AT_RE.test(at) || Number.isNaN(Date.parse(at)) || !CURSOR_ID_RE.test(id) || BigInt(id) > MAX_BIGINT) return null;
  return { at, id };
}

// LIKE metacharacters in the owner's own search text stay literal: a typed '%' searches for a
// percent sign, not for anything (reads.ts escapes the same three characters).
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** A YYYY-MM-DD that has to survive a round trip through Date, exactly as money_out/routes.ts does it. */
const isRealDay = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, { message: 'Enter a real date.' });

const listSchema = z.object({
  personId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(120).optional(),
  from: dayString.optional(), to: dayString.optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
}).refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'The end date must be on or after the start date.', path: ['to'] });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

/**
 * Who did what, read-only, for the owner alone. The same gate /api/people uses: these rows are the
 * owner's own record of what was done to their settings, operators and money, and the plan puts the
 * page under Organisation.
 */
export function auditRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf);
  const ownerOnly: RequestHandler = (req, _res, next) => {
    if (req.person?.is_owner) return next();
    next(new HttpError(403, 'owner_only', 'Only the owner can do this.'));
  };
  r.use(ownerOnly);

  r.get('/', async (req, res, next) => {
    try {
      const q = parse(listSchema, req.query);
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.personId) { params.push(q.personId); where.push(`a.person_id = $${params.length}::uuid`); }
      if (q.action) { params.push(q.action); where.push(`a.action = $${params.length}`); }
      // Days are the owner's own calendar day (Africa/Nairobi), like every other list.
      if (q.from) { params.push(q.from); where.push(`(a.at AT TIME ZONE 'Africa/Nairobi')::date >= $${params.length}::date`); }
      if (q.to) { params.push(q.to); where.push(`(a.at AT TIME ZONE 'Africa/Nairobi')::date <= $${params.length}::date`); }
      if (q.q) {
        params.push(`%${escapeLike(q.q)}%`);
        const n = params.length;
        where.push(`(a.action ILIKE $${n} ESCAPE '\\' OR a.target ILIKE $${n} ESCAPE '\\' OR a.before_json::text ILIKE $${n} ESCAPE '\\' OR a.after_json::text ILIKE $${n} ESCAPE '\\')`);
      }
      const cur = q.cursor ? decodeCursor(q.cursor) : null;
      if (q.cursor && !cur) throw new HttpError(400, 'bad_cursor', 'That page link has expired. Reload the page.');
      if (cur) {
        params.push(cur.at, cur.id);
        const n = params.length;
        // The id is the tiebreak, so rows written in the same microsecond still page in one stable order.
        where.push(`(a.at, a.id) < ($${n - 1}::timestamptz, $${n}::bigint)`);
      }
      params.push(q.limit + 1);
      const rows = await deps.db.query<Row>(
        `${SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY a.at DESC, a.id DESC LIMIT $${params.length}`,
        params,
      );
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const last = page[page.length - 1];
      const body: AuditPage = { items: page.map(toView), nextCursor: more && last ? encodeCursor(last.at_cursor, last.id) : null };
      res.json(body);
    } catch (e) { next(e); }
  });

  r.get('/actions', async (_req, res, next) => {
    try {
      // One row per action the organisation has ever recorded; the filter's own list.
      const rows = await deps.db.query<{ action: string }>('SELECT DISTINCT action FROM audit_log ORDER BY action');
      res.json({ items: rows.map((row) => row.action) });
    } catch (e) { next(e); }
  });

  return r;
}
