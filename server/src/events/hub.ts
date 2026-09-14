import pg from 'pg';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';

export interface StudioEvent { type: string; payload: unknown; at: string; orgId: string | null }
export interface EventHub {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The organisation defaults to the one in scope; sse only delivers an event to that organisation. */
  publish(type: string, payload: unknown, orgId?: string | null): Promise<void>;
  subscribe(fn: (e: StudioEvent) => void): () => void;
}

const CHANNEL = 'studio_events';
const MAX_BACKOFF_MS = 30_000;

export function formatSse(e: StudioEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** Exponential backoff for LISTEN reconnects: 1s, 2s, 4s, ... capped at 30s. */
export function nextBackoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
}

export function createEventHub(connectionString: string, db: Db, opts?: { clientFactory?: () => pg.Client }): EventHub {
  // This raw pg.Client connects as DATABASE_URL's own user (a superuser in the bundled Compose
  // file), never studio_app — it only ever issues LISTEN/NOTIFY, never a table statement. Keep it
  // that way: it is a standing connection no allowlist covers.
  const makeClient = opts?.clientFactory ?? (() => new pg.Client({ connectionString }));
  const subs = new Set<(e: StudioEvent) => void>();
  let client: pg.Client | null = null;
  let connecting: pg.Client | null = null;
  let stopped = true;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lostLogged = false;

  function attach(c: pg.Client) {
    c.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      let e: StudioEvent;
      try { e = JSON.parse(msg.payload) as StudioEvent; } catch { return; }
      for (const fn of subs) { try { fn(e); } catch { /* subscriber errors never break the hub */ } }
    });
    c.on('error', () => scheduleReconnect());
    c.on('end', () => scheduleReconnect());
  }

  // Tear down a client that has just been superseded by a newer one.
  function teardown(old: pg.Client | null) {
    if (!old) return;
    old.removeAllListeners();
    void old.end().catch(() => {});
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    if (!lostLogged) { console.error('event hub connection lost, reconnecting'); lostLogged = true; }
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      const c = makeClient();
      connecting = c;
      (async () => {
        await c.connect();
        attach(c);
        await c.query(`LISTEN ${CHANNEL}`);
        connecting = null;
        // stop() may have run while we were awaiting connect/LISTEN above — don't let
        // this in-flight reconnect win the race and leave a live client behind.
        if (stopped) { await c.end().catch(() => {}); return; }
        const old = client;
        client = c;
        teardown(old);
        reconnectAttempt = 0;
        lostLogged = false;
        console.error('event hub reconnected');
      })().catch(() => { connecting = null; scheduleReconnect(); });
    }, nextBackoffMs(reconnectAttempt));
  }

  return {
    async start() {
      stopped = false;
      const c = makeClient();
      connecting = c;
      await c.connect();
      attach(c);
      await c.query(`LISTEN ${CHANNEL}`);
      connecting = null;
      // Same race as above: stop() may have already run during this await.
      if (stopped) { await c.end().catch(() => {}); return; }
      client = c;
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (connecting) { const c = connecting; connecting = null; await c.end().catch(() => {}); }
      await client?.end();
      client = null;
    },
    async publish(type, payload, orgId = currentOrgId()) {
      const e: StudioEvent = { type, payload, at: new Date().toISOString(), orgId };
      await db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(e)]);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
