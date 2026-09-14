import { Router } from 'express';
import type { Db } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';
import { formatSse, type EventHub } from './hub.js';

const DEFAULT_HEARTBEAT_MS = 25_000;
/** Three misses in a row, not one: a single slow or dropped query on an otherwise-live database
 * must not close a stream that is actually fine. */
const MAX_CONSECUTIVE_CHECK_FAILURES = 3;

export function sseRoute(hub: EventHub, db: Db, opts: { heartbeatMs?: number } = {}): Router {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const r = Router();
  r.get('/', requireAuth(db), (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.on('error', () => { /* client gone; guarded writes below no-op */ });
    res.write(': connected\n\n');
    // Captured once, at connect. A person who was a host admin when the stream opened but has
    // since been demoted (or whose organisation has since been un-hosted) must not go on reading
    // the host's own housekeeping forever — the heartbeat below re-checks this against the current
    // row, not this snapshot.
    const wasHostAdmin = req.person?.is_host_admin === true && req.org?.isHost === true;
    const sessionId = req.sessionId;
    const personId = req.person?.id;
    const unsub = hub.subscribe((e) => {
      // An event that belongs to an organisation reaches that organisation's sessions and no
      // others. An event that belongs to none is the host's own housekeeping and reaches only
      // people who are, right now, a host admin inside the host organisation (spec 10.5).
      const mine = e.orgId === null
        ? req.person?.is_host_admin === true && req.org?.isHost === true
        : e.orgId === req.org?.id;
      if (!mine) return;
      if (!res.writableEnded) res.write(formatSse(e));
    });
    // `checking` keeps two heartbeats from ever overlapping — a slow database round trip must not
    // start a second check on top of one still in flight. `failures` only closes the stream after
    // several misses in a row, so one transient error does not drop an otherwise-live connection.
    let checking = false;
    let failures = 0;
    const beat = setInterval(() => {
      if (res.writableEnded) { clearInterval(beat); return; }
      if (checking) return;
      checking = true;
      void (async () => {
        try {
          // A session the suspend/resume path (or an ordinary logout elsewhere) has deleted no
          // longer has a live connection to answer for — spec 6.1's "ends the tenant's sessions"
          // only means anything if a stream already open at that moment actually closes.
          const [alive] = sessionId
            ? await db.query<{ ok: number }>('SELECT 1 AS ok FROM sessions WHERE id=$1 AND expires_at > now()', [sessionId])
            : [];
          if (!alive) { res.end(); return; }
          if (wasHostAdmin) {
            const [p] = await db.query<{ is_host_admin: boolean; org_is_host: boolean }>(
              'SELECT p.is_host_admin, o.is_host AS org_is_host FROM people p JOIN orgs o ON o.id = p.org_id WHERE p.id = $1',
              [personId],
            );
            if (!p || !p.is_host_admin || !p.org_is_host) { res.end(); return; }
          }
          failures = 0;
          if (!res.writableEnded) res.write(': ping\n\n');
        } catch {
          failures++;
          if (failures >= MAX_CONSECUTIVE_CHECK_FAILURES) {
            // Never the session id: this is the one line that can fire without any of the checks
            // above having told us the session is even still legitimate.
            console.error(`event stream heartbeat check failed ${MAX_CONSECUTIVE_CHECK_FAILURES} times in a row; closing the stream`);
            res.end();
          }
        } finally {
          checking = false;
        }
      })();
    }, heartbeatMs);
    req.on('close', () => { clearInterval(beat); unsub(); });
  });
  return r;
}
