import type { Db } from '../db/pool.js';
import { explain, type DarajaScope } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { COLLECT_KINDS, KINDS, LEDGER_TYPES, type RequestRow } from './registry.js';
import { AUTH_FAILED_MEANING } from './service.js';

export interface RequestView {
  id: string; type: string; subtype: string | null; status: string; amountCents: number | null; currency: 'KES';
  recipient: { kind: string | null; value: string | null; name: string | null }; remarks: string | null; receipt: string | null;
  createdAt: string; sentAt: string | null; resultAt: string | null; resultSource: 'callback' | 'poll' | 'ack' | null;
  safaricomSaid: string | null; meaning: string | null; whatToDo: string | null; retriable: boolean; pollAttempts: number;
  checked: { by: { id: string; displayName: string } | null; at: string; note: string } | null;
  createdBy: { id: string; displayName: string } | null;
}

export type ViewRow = RequestRow & { created_by_name?: string | null; checked_by_name?: string | null; created_cursor?: string };

/** Every column the view needs, with the two display-name joins, plus a microsecond-exact text
 * rendering of created_at for cursor paging — a JS Date only holds milliseconds, so the
 * cursor must be built from this text column, never from row.created_at. Append WHERE/ORDER/LIMIT. */
export const VIEW_SELECT = `SELECT r.*, p.display_name AS created_by_name, c.display_name AS checked_by_name,
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor
  FROM requests r LEFT JOIN people p ON p.id = r.created_by LEFT JOIN people c ON c.id = r.checked_by`;

export const UNKNOWN_WHAT_TO_DO = 'Do not send it again yet. Studio is checking with Safaricom; if it stays unknown, check the Safaricom portal, then Mark as checked.';
export const POLL_FAILED_WHAT_TO_DO = "Safaricom's record is final. Send again if the money did not arrive; contact Safaricom API support if the portal statement disagrees.";
export const AUTH_FAILED_WHAT_TO_DO = 'Open Settings › Daraja app and re-enter the consumer key and secret, then try again.';

// null when the request's type is neither a money-out kind nor one of the two lookup types —
// never guess a catalog scope for a type we don't recognise.
const scopeOf = (type: string): DarajaScope | null => {
  // M1: both directions. A payment request is an ordinary row here, so its Safaricom result text
  // must be explained from the `stk` catalog rather than falling through to null and showing the
  // operator a bare code with no meaning.
  const kind = KINDS[type] ?? COLLECT_KINDS[type];
  if (kind) return kind.scope;
  if (type === 'status_query') return 'status';
  if (type === 'balance') return 'balance';
  return null;
};

/**
 * `egressIps` is the hosted service's own outgoing addresses; they only ever change the "what to do
 * now" line for 403.002.1001 (spec 4.6). Single mode passes none and reads exactly as it always has.
 */
export function toView(row: ViewRow, egressIps: string[] = []): RequestView {
  // whatToDo is derived at read time so copy changes apply to old rows; the stored `meaning`
  // (Safaricom's catalog text or the studio note for unknown/connection cases) is kept as is.
  const scope = scopeOf(row.type);
  // b2cApiUsed (recorded on every b2c send) picks the v3-specific 403.002.1001 copy over the
  // general one — read at view time, same as the rest of `ex`, so copy changes still apply to old
  // rows.
  const b2cApiUsed = scope === 'b2c' ? (row.payload_json as { b2cApiUsed?: 'v1' | 'v3' }).b2cApiUsed : undefined;
  const ex = row.result_code !== null && scope !== null ? explain(scope, row.result_code, row.result_desc ?? '', { b2cApiUsed, egressIps }) : null;
  return {
    id: row.id, type: row.type, subtype: row.subtype, status: row.status,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents), currency: 'KES',
    recipient: { kind: row.recipient_kind, value: row.recipient_value, name: row.recipient_name },
    remarks: row.remarks, receipt: row.receipt,
    createdAt: row.created_at.toISOString(), sentAt: row.sent_at?.toISOString() ?? null, resultAt: row.result_at?.toISOString() ?? null, resultSource: row.result_source,
    safaricomSaid: row.result_desc, meaning: row.meaning ?? ex?.meaning ?? null,
    whatToDo: row.status === 'failed'
      ? (ex?.whatToDo ?? (row.result_source === 'poll' ? POLL_FAILED_WHAT_TO_DO
          : row.result_code === null && row.meaning === AUTH_FAILED_MEANING ? AUTH_FAILED_WHAT_TO_DO
          : null))
      // W4: once a human has checked it, studio is not going to check it itself (the sweep and its
      // expiry both exclude checked_at IS NOT NULL rows) — telling the operator "Studio is
      // checking with Safaricom" would be a lie.
      : row.status === 'unknown' ? (row.checked_at ? null : (ex?.whatToDo ?? UNKNOWN_WHAT_TO_DO)) : null,
    retriable: row.retriable ?? false, pollAttempts: row.poll_attempts,
    checked: row.checked_at ? { by: row.checked_by ? { id: row.checked_by, displayName: row.checked_by_name ?? '' } : null, at: row.checked_at.toISOString(), note: row.checked_note ?? '' } : null,
    createdBy: row.created_by ? { id: row.created_by, displayName: row.created_by_name ?? '' } : null,
  };
}

export async function getRequest(db: Db, id: string, egressIps: string[] = []): Promise<RequestView | null> {
  const rows = await db.query<ViewRow>(`${VIEW_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ? toView(rows[0], egressIps) : null;
}

export interface ListQuery { type?: string[]; status?: string; from?: string; to?: string; q?: string; limit: number; cursor?: string }
export interface Page<T> { items: T[]; nextCursor: string | null }

// Matches exactly what VIEW_SELECT's created_cursor column produces — a UTC, microsecond-exact
// text rendering of created_at. A cursor whose `at` half doesn't match this shape, or whose
// `id` half isn't a real uuid (the same strict shape routes.ts uses for path ids), is rejected
// before it ever reaches a SQL cast — a bad cast there would otherwise 500 and log the
// attacker-controlled literal.
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (createdCursor: string, id: string) => Buffer.from(`${createdCursor}|${id}`).toString('base64url');
function decodeCursor(c: string): { at: string; id: string } | null {
  let s: string;
  try { s = Buffer.from(c, 'base64url').toString('utf8'); } catch { return null; }
  const i = s.indexOf('|');
  if (i < 0) return null;
  const at = s.slice(0, i); const id = s.slice(i + 1);
  if (!CURSOR_AT_RE.test(at) || Number.isNaN(Date.parse(at)) || !CURSOR_ID_RE.test(id)) return null;
  return { at, id };
}

// LIKE metacharacters in the operator's own search text must stay literal — '%' or '_' typed
// into the search box should search for that character, not act as a wildcard.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** History hides operator probes, the sweep's own polls and a manual check's own status_query row
 * (subtype='manual', pollOne) — the operator sees the outcome on the target row, not a
 * separate History row for the check itself. */
export async function listRequests(db: Db, query: ListQuery, egressIps: string[] = []): Promise<Page<RequestView>> {
  const where: string[] = [`r.type = ANY($1)`, `(r.subtype IS NULL OR r.subtype NOT IN ('operator_probe','sweep','manual'))`];
  // M1: History is the one place the two directions are shown together — money sent and money
  // asked for. `MONEY_TYPES` stays money-out only because the send allowance and the sweep count
  // it; the ledger the operator reads is `LEDGER_TYPES`.
  const params: unknown[] = [query.type?.length ? query.type : LEDGER_TYPES];
  if (query.status) { params.push(query.status); where.push(`r.status = $${params.length}`); }
  // Day bounds are the operator's own calendar day (Africa/Nairobi, M2), not the server's UTC day.
  if (query.from) { params.push(query.from); where.push(`(r.created_at AT TIME ZONE 'Africa/Nairobi')::date >= $${params.length}::date`); }
  if (query.to) { params.push(query.to); where.push(`(r.created_at AT TIME ZONE 'Africa/Nairobi')::date <= $${params.length}::date`); }
  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    params.push(like, like, like, query.q);
    const n = params.length;
    const parts = [
      `r.recipient_value ILIKE $${n - 3} ESCAPE '\\'`,
      `r.recipient_name ILIKE $${n - 2} ESCAPE '\\'`,
      `r.receipt ILIKE $${n - 1} ESCAPE '\\'`,
      `r.originator_conversation_id = $${n}`,
    ];
    // W1: recipient_value stores the e.164 form (254…); the search box says "phone" and studio
    // itself displays "0792 471 415", so a query that is a Kenyan mobile number in any common
    // written form (0700123456, 0700 123 456, +254700123456, 700123456) must also match by its
    // normalised e.164 value, not just as a raw ILIKE substring of the stored digits.
    const digits = query.q.replace(/[\s()-]/g, '');
    const phoneMatch = /^\+?(?:254|0)?([17]\d{8})$/.exec(digits);
    if (phoneMatch) { params.push(`254${phoneMatch[1]}`); parts.push(`r.recipient_value = $${params.length}`); }
    where.push(`(${parts.join(' OR ')})`);
  }
  const cur = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cur) throw new HttpError(400, 'bad_cursor', 'That page link has expired. Reload History.');
  if (cur) {
    params.push(cur.at, cur.id);
    const n = params.length;
    where.push(`(r.created_at, r.id) < ($${n - 1}::timestamptz, $${n}::uuid)`);
  }
  params.push(query.limit + 1);
  const rows = await db.query<ViewRow>(`${VIEW_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > query.limit;
  const page = more ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return { items: page.map((row) => toView(row, egressIps)), nextCursor: more && last && last.created_cursor ? encodeCursor(last.created_cursor, last.id) : null };
}
