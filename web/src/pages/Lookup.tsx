import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import type { RequestView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Card } from '../components/Card';
import { TaskCard } from '../components/TaskCard';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money } from '../format';

export function Lookup() {
  const toast = useToast();
  const [receipt, setReceipt] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<RequestView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const clean = receipt.trim().toUpperCase();
  const valid = /^[A-Z0-9]{10}$/.test(clean);
  const reload = useCallback((id: string) => api.get<RequestView>(`/api/requests/${id}`).then((r) => {
    setResult(r);
    if (r.status !== 'sent') {
      setPending(null);
      if (r.status === 'completed') toast.success(r.meaning ?? copy.lookup.says);
      else if (r.status === 'unknown') toast.error(copy.lookup.noAnswer);
      else if (r.status === 'failed') toast.error(r.meaning ?? r.safaricomSaid ?? copy.error.generic);
    }
  }).catch(() => {}), [toast]);
  // W2: re-fetch on every SSE (re)connect, not just on an event that might never arrive, and keep
  // polling every 15 s while the lookup is still pending — never a busy loop, cleared once the
  // answer is in or the component unmounts.
  useEvents(useCallback((e) => { const p = e.payload as { id?: string }; if (e.type === 'request.updated' && pending && p.id === pending) void reload(pending); }, [pending, reload]), pending !== null, useCallback(() => { if (pending) void reload(pending); }, [pending, reload]));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => reload(pending), 15_000);
    return () => clearInterval(t);
  }, [pending, reload]);
  const ask = async () => {
    setErr(null); setResult(null);
    try { const r = await api.post<{ requestId: string }>('/api/lookup', { receipt: clean }); setPending(r.requestId); toast.info(copy.lookup.asking); }
    catch (e) { setErr(explainApiError(e)); }
  };
  const explained = result?.status === 'failed' && result.safaricomSaid && result.meaning && result.whatToDo ? { safaricomSaid: result.safaricomSaid, meaning: result.meaning, whatToDo: result.whatToDo } : null;
  return (
    <>
      <PageHeader title={copy.lookup.title} safaricom={copy.lookup.safaricom} />
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) void ask(); }}>
        <TaskCard footerStart={<Link to="/history">{copy.lookup.history}</Link>} footer={<Button type="submit" disabled={!valid || pending !== null}>{copy.lookup.button}</Button>}>
          <TextField label={copy.lookup.receipt} value={receipt} onChange={(e) => setReceipt(e.target.value)} autoFocus autoComplete="off" hint={copy.lookup.hint} />
          <ErrorCard error={err} />
          {pending && !result && <p role="status" className="text-base text-muted">{copy.lookup.asking}</p>}
        </TaskCard>
        {result && result.status === 'completed' && (
          <Card className="max-w-xl" title={copy.lookup.says}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
              <dt className="text-muted">{copy.lookup.says}</dt><dd>{result.meaning}</dd>
              <dt className="text-muted">{copy.request.receipt}</dt><dd><code>{result.receipt}</code></dd>
              <dt className="text-muted">{copy.request.amount}</dt><dd>{money(result.amountCents)}</dd>
              {result.recipient.name && <><dt className="text-muted">{copy.request.to}</dt><dd>{result.recipient.name}</dd></>}
            </dl>
          </Card>
        )}
        {explained && <div className="max-w-xl"><ErrorCard error={explained} /></div>}
        {result && result.status === 'failed' && !explained && <div className="max-w-xl"><ErrorCard error={new Error(result.meaning ?? result.safaricomSaid ?? copy.error.generic)} /></div>}
        {result && result.status === 'unknown' && <p role="alert" className="max-w-xl text-base">{copy.lookup.noAnswer}</p>}
      </form>
    </>
  );
}
