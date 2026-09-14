import { useCallback, useEffect, useState } from 'react';
import { api } from './client';
import type { StudioEvent } from './events';
import { explainApiError, type Explained } from '../components/ErrorCard';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';

/**
 * Asks Safaricom for a fresh balance and waits for the answer. It does not open its own event
 * stream: the page wires `onEvent` into the `useEvents` it already has, and `checkPending` into
 * that stream's reconnect callback, so a page never holds two connections.
 */
export function useBalanceRefresh(onUpdated: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const settle = useCallback((result: 'ok' | 'noAnswer') => {
    setBusy(false); setPending(null);
    if (result === 'noAnswer') { setMsg(copy.balances.noAnswer); toast.error(copy.balances.noAnswer); }
    else { setMsg(null); toast.success(copy.balances.refreshed); onUpdated(); }
  }, [onUpdated, toast]);
  // A missed event (dropped connection, or the window before it connects) would otherwise leave
  // "Asking Safaricom…" showing forever: on every reconnect, and every 15 s while a refresh is
  // outstanding, read the refresh request directly.
  const checkPending = useCallback(() => {
    if (!pending) return;
    api.get<{ status: string }>(`/api/requests/${pending}`).then((r) => {
      if (r.status === 'unknown') settle('noAnswer');
      else if (r.status !== 'sent') settle('ok');
    }).catch(() => {});
  }, [pending, settle]);
  const onEvent = useCallback((e: StudioEvent) => {
    if (e.type === 'balance.updated') settle('ok');
    if (e.type === 'request.updated') {
      const p = e.payload as { id?: string; status?: string };
      if (pending && p.id === pending && p.status === 'unknown') settle('noAnswer');
    }
  }, [pending, settle]);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(checkPending, 15_000);
    return () => clearInterval(t);
  }, [pending, checkPending]);
  const refresh = useCallback(async () => {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.post<{ requestId: string }>('/api/balances/refresh'); setPending(r.requestId); toast.info(copy.balances.refreshing); }
    catch (e) { setBusy(false); setErr(explainApiError(e)); }
  }, [toast]);
  return { busy, msg, err, refresh, onEvent, checkPending };
}
