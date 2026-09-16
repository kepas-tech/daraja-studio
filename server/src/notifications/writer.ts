import { withOrg, type Db } from '../db/pool.js';
import type { EventHub, StudioEvent } from '../events/hub.js';
import { getRequest, type RequestView } from '../money_out/reads.js';
import { classify } from './classify.js';
import type { NotificationsService } from './service.js';

export interface NotificationWriter {
  start(): void;
  stop(): void;
  /** One event through the whole path. Exported so a test can drive it without a hub or a timer. */
  handle(e: StudioEvent): Promise<void>;
}

/** The events whose payload names a request row this writer has to load before it can say anything. */
const NEEDS_REQUEST = new Set(['request.updated']);

export function createNotificationWriter(deps: {
  db: Db; events: EventHub; notifications: NotificationsService; egressIps?: string[];
}): NotificationWriter {
  let unsubscribe: (() => void) | null = null;

  async function loadRequest(e: StudioEvent): Promise<RequestView | null> {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const id = typeof payload.id === 'string' ? payload.id : null;
    if (!id) return null;
    const isRequestEvent = NEEDS_REQUEST.has(e.type) || (e.type === 'alert' && payload.kind === 'request_unknown');
    if (!isRequestEvent) return null;
    return getRequest(deps.db, id, deps.egressIps ?? []);
  }

  async function handle(e: StudioEvent): Promise<void> {
    // The hub is started before any organisation is in scope, so the event's own orgId is the only
    // honest answer; single mode's fallback covers a legacy publisher that stamped none.
    const org = e.orgId ?? deps.db.getFallbackOrg();
    if (!org) return;
    await withOrg(org, async () => {
      const request = await loadRequest(e);
      const c = classify({ type: e.type, payload: e.payload, request });
      if (c) await deps.notifications.write(c);
    });
  }

  return {
    handle,
    start() {
      if (unsubscribe) return;
      unsubscribe = deps.events.subscribe((e) => {
        // One event must never take the hub down with it: the hub already isolates a throwing
        // subscriber, and this catch covers the asynchronous half it cannot see.
        void handle(e).catch((err) => console.error('notification writer failed', err instanceof Error ? err.message : err));
      });
    },
    stop() { unsubscribe?.(); unsubscribe = null; },
  };
}
