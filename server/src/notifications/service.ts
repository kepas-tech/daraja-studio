import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import { HttpError } from '../util/errors.js';
import type { Classified } from './classify.js';

export interface NotificationView {
  id: string; severity: string; category: string; type: string; title: string; body: string;
  data: Record<string, unknown>; count: number; readAt: string | null; createdAt: string; updatedAt: string;
}
export interface NotificationPage { items: NotificationView[]; unread: number; nextCursor: string | null }
export interface NotificationsService {
  /** One row for the event, or a bump of the row that already stands for it. */
  write(c: Classified): Promise<{ created: boolean }>;
  list(q: { filter: 'all' | 'unread'; limit: number; cursor?: string }): Promise<NotificationPage>;
  count(): Promise<number>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<number>;
}

interface NotificationRow {
  id: string; severity: string; category: string; type: string; title: string; body: string;
  data: Record<string, unknown>; count: number; read_at: Date | null; created_at: Date; updated_cursor: string;
}

const SELECT = `SELECT n.id, n.severity, n.category, n.type, n.title, n.body, n.data, n.count, n.read_at, n.created_at,
  to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_cursor
  FROM notifications n`;

// The same shape reads.ts uses for its cursor: a microsecond-exact rendering of the timestamp, so
// two rows written in the same millisecond still page in a stable order.
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (at: string, id: string) => Buffer.from(at + '|' + id).toString('base64url');
function decodeCursor(c: string): { at: string; id: string } | null {
  let s: string;
  try { s = Buffer.from(c, 'base64url').toString('utf8'); } catch { return null; }
  const i = s.indexOf('|');
  if (i < 0) return null;
  const at = s.slice(0, i); const id = s.slice(i + 1);
  if (!CURSOR_AT_RE.test(at) || Number.isNaN(Date.parse(at)) || !CURSOR_ID_RE.test(id)) return null;
  return { at, id };
}

const toView = (r: NotificationRow): NotificationView => ({
  id: r.id, severity: r.severity, category: r.category, type: r.type, title: r.title, body: r.body,
  data: r.data ?? {}, count: r.count,
  readAt: r.read_at ? r.read_at.toISOString() : null,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_cursor,
});

/**
 * Feature 4. Every statement runs inside the caller's organisation (orgContext on a request,
 * withOrg in the writer), and the explicit org predicate is the stores' own defence in depth, the
 * same convention settings/store.ts follows.
 */
export function createNotificationsService(deps: { db: Db; events: EventHub }): NotificationsService {
  const orgId = () => currentOrgId();

  async function unread(): Promise<number> {
    const [row] = await deps.db.query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE org_id = $1 AND read_at IS NULL', [orgId()]);
    return row?.n ?? 0;
  }

  return {
    async write(c) {
      const org = orgId();
      if (!org) throw new Error('a notification needs an organisation');
      // The upsert is the dedupe: a repeat bumps count and refreshes updated_at, and read_at is
      // deliberately not in the SET, so a line the owner already read stays read.
      const [row] = await deps.db.query<{ id: string; created: boolean }>(
        `INSERT INTO notifications(org_id, severity, category, type, title, body, data, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (org_id, dedupe_key) DO UPDATE
           SET count = notifications.count + 1, updated_at = now(), severity = EXCLUDED.severity,
               title = EXCLUDED.title, body = EXCLUDED.body, data = EXCLUDED.data
         RETURNING id, (xmax = 0) AS created`,
        [org, c.severity, c.category, c.type, c.title, c.body, JSON.stringify(c.data), c.dedupeKey]);
      // What the bell listens to. Published by the writer's own process, so it also reaches the SSE
      // clients of this studio.
      await deps.events.publish('notification.created', { id: row.id }, org);
      return { created: row.created };
    },

    async list(q) {
      const org = orgId();
      const where = ['n.org_id = $1'];
      const params: unknown[] = [org];
      if (q.filter === 'unread') where.push('n.read_at IS NULL');
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        // A cursor we cannot read is a stale page, not an error: answer the first page again.
        if (c) {
          params.push(c.at, c.id);
          where.push('(n.updated_at, n.id) < ($' + (params.length - 1) + '::timestamptz, $' + params.length + '::uuid)');
        }
      }
      params.push(q.limit + 1); // one more than asked for, to know whether another page exists
      const rows = await deps.db.query<NotificationRow>(
        SELECT + ' WHERE ' + where.join(' AND ') + ' ORDER BY n.updated_at DESC, n.id DESC LIMIT $' + params.length, params);
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(toView),
        unread: await unread(),
        nextCursor: more && last ? encodeCursor(last.updated_cursor, last.id) : null,
      };
    },

    count: unread,

    async markRead(id) {
      const org = orgId();
      const rows = await deps.db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND org_id = $2 AND read_at IS NULL RETURNING id', [id, org]);
      if (rows.length > 0) return;
      // Already read is not an error: pressing the line twice must be harmless.
      const exists = await deps.db.query('SELECT 1 FROM notifications WHERE id = $1 AND org_id = $2', [id, org]);
      if (exists.length === 0) throw new HttpError(404, 'not_found', 'That notification does not exist.');
    },

    async markAllRead() {
      const rows = await deps.db.query<{ id: string }>(
        'UPDATE notifications SET read_at = now() WHERE org_id = $1 AND read_at IS NULL RETURNING id', [orgId()]);
      return rows.length;
    },
  };
}
