import { useEffect } from 'react';
export interface StudioEvent { type: string; payload: unknown; at: string }
// W2: a page must not trust a single SSE delivery — the window between a POST's own read and the
// browser's EventSource connecting, or any drop of the connection (a proxy idle-timeout, a laptop
// sleep), can lose an event with nothing left to tell the page. `onOpen` fires on the *first*
// connect and on every browser reconnect, so a caller can re-fetch its own state there instead of
// waiting for an event that may never come.
export function useEvents(onEvent: (e: StudioEvent) => void, enabled = true, onOpen?: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource('/api/events');
    const handler = (ev: MessageEvent) => { try { onEvent(JSON.parse(ev.data)); } catch { /* ignore */ } };
    // Every named event the server publishes to a tenant stream, in one place: a name missing here
    // is a screen that never hears about the change (review correction B08).
    for (const t of ['request.updated', 'balance.updated', 'operator.updated', 'alert', 'setup.updated', 'billing.updated', 'org.updated']) es.addEventListener(t, handler as EventListener);
    if (onOpen) es.onopen = () => onOpen();
    return () => es.close();
  }, [onEvent, enabled, onOpen]);
}
