import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useEvents } from '../../api/events';
import type { RequestView } from '../../api/types';

/** Follow one money-in request until it settles: live events, a re-read on reconnect, and a slow poll while it is out. */
export function useCollectResult() {
  const [request, setRequest] = useState<RequestView | null>(null);
  const idRef = useRef<string | null>(null);
  idRef.current = request?.id ?? null;
  const reload = useCallback((id: string) => api.get<RequestView>(`/api/requests/${id}`).then(setRequest).catch(() => {}), []);
  useEvents(useCallback((e) => { const p = e.payload as { id?: string }; if (e.type === 'request.updated' && idRef.current && p.id === idRef.current) void reload(idRef.current); }, [reload]), request !== null, useCallback(() => { if (idRef.current) void reload(idRef.current); }, [reload]));
  useEffect(() => {
    if (request?.status !== 'sent') return;
    const t = setInterval(() => { if (idRef.current) void reload(idRef.current); }, 15_000);
    return () => clearInterval(t);
  }, [request?.status, reload]);
  return { request, setRequest };
}
