import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import type { BalanceView } from '../api/types';
import { Button } from '../components/Button';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, when } from '../format';

const STALE_MS = 24 * 3600 * 1000;

function Card({ title, hint, cents }: { title: string; hint?: string; cents: number | null | undefined }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="text-base text-gray-600 dark:text-gray-400">{title}</h2>
      <p className="text-3xl font-semibold">{money(cents)}</p>
      {hint && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

export function Balances() {
  const toast = useToast();
  const [b, setB] = useState<BalanceView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const load = useCallback(() => api.get<BalanceView | null>('/api/balances/latest').then(setB).catch((e) => setErr(explainApiError(e))), []);
  useEffect(() => { void load(); }, [load]);
  const settle = (result: 'ok' | 'noAnswer') => {
    setBusy(false); setPending(null);
    if (result === 'noAnswer') { setMsg(copy.balances.noAnswer); toast.error(copy.balances.noAnswer); }
    else { setMsg(null); toast.success(copy.balances.refreshed); void load(); }
  };
  // W2: a missed 'balance.updated'/'request.updated' event (a dropped SSE connection, or the
  // window before it even connects) otherwise leaves "Asking Safaricom…" showing forever. On
  // every SSE (re)connect, and every 15 s while a refresh is outstanding, check the refresh
  // request directly instead of only trusting the next event.
  const checkPending = useCallback(() => {
    if (!pending) return;
    api.get<{ status: string }>(`/api/requests/${pending}`).then((r) => {
      if (r.status === 'unknown') settle('noAnswer');
      else if (r.status !== 'sent') settle('ok');
    }).catch(() => {});
  }, [pending, load]);
  useEvents(useCallback((e) => {
    if (e.type === 'balance.updated') settle('ok');
    if (e.type === 'request.updated') {
      const p = e.payload as { id?: string; status?: string };
      if (pending && p.id === pending && p.status === 'unknown') settle('noAnswer');
    }
  }, [load, pending]), true, checkPending);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(checkPending, 15_000);
    return () => clearInterval(t);
  }, [pending, checkPending]);
  const refresh = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try { const r = await api.post<{ requestId: string }>('/api/balances/refresh'); setPending(r.requestId); toast.info(copy.balances.refreshing); }
    catch (e) { setBusy(false); setErr(explainApiError(e)); }
  };
  const stale = b?.queriedAt ? Date.now() - new Date(b.queriedAt).getTime() > STALE_MS : false;
  return (
    <>
      <PageHeader title={copy.balances.title} safaricom={copy.balances.safaricom}>
        <Button type="button" onClick={() => void refresh()} disabled={busy}>{busy ? copy.balances.refreshing : copy.balances.refresh}</Button>
      </PageHeader>
      {msg && <p role="status" className="mb-4 text-base text-amber-800 dark:text-amber-300">{msg}</p>}
      <ErrorCard error={err} />
      {b === null && <p className="text-base">{copy.balances.never}</p>}
      {b && (
        <div className="space-y-4">
          <p className="text-base text-gray-600 dark:text-gray-400">{copy.balances.asOf(when(b.queriedAt))}</p>
          {stale && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-base dark:bg-amber-950/30">{copy.balances.stale}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title={copy.balances.working} hint={copy.balances.workingHint} cents={b.workingCents} />
            <Card title={copy.balances.utility} hint={copy.balances.utilityHint} cents={b.utilityCents} />
            <Card title={copy.balances.charges} cents={b.chargesPaidCents} />
          </div>
        </div>
      )}
    </>
  );
}
