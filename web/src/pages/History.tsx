import { useCallback, useEffect, useState } from 'react';
import { useEvents } from '../api/events';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { useToast } from '../components/Toast';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { Page, RequestView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { StatusPill } from '../components/StatusPill';
import { STATUS_TONE } from '../components/RequestCard';
import { PageHeader } from '../components/PageHeader';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';

const PAGE = 7;
const STATUSES = ['completed', 'sent', 'failed', 'unknown', 'pending', 'cancelled'];
/** Which way the money moved. Types are named here, not on the server, so the filter is one query param. */
const DIRECTION_TYPES: Record<string, string> = { in: 'c2b,stk', out: 'b2c,reversal' };

export function History() {
  const toast = useToast();
  const [q, setQ] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [status, setStatus] = useState(''); const [direction, setDirection] = useState('');
  const [items, setItems] = useState<RequestView[]>([]); const [next, setNext] = useState<string | null>(null); const [loaded, setLoaded] = useState(false);
  // Keyset paging is forward-only on the server; Previous is the stack of cursors we came through.
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1] ?? null;
  // Look up: a receipt that never passed through here can still be asked about. Ported from the
  // old Look up page: start the query, then follow the answer over SSE with a slow poll behind it.
  const receiptTyped = q.trim().toUpperCase();
  const isReceipt = /^[A-Z0-9]{10}$/.test(receiptTyped);
  const [pending, setPending] = useState<string | null>(null);
  const [lookup, setLookup] = useState<RequestView | null>(null);
  const [lookupErr, setLookupErr] = useState<Error | Explained | null>(null);
  const [askedFor, setAskedFor] = useState('');
  const reload = useCallback((id: string) => api.get<RequestView>(`/api/requests/${id}`).then((r) => {
    setLookup(r);
    if (r.status !== 'sent') {
      setPending(null);
      if (r.status === 'completed') toast.success(r.meaning ?? copy.lookup.says);
      else if (r.status === 'unknown') toast.error(copy.lookup.noAnswer);
      else if (r.status === 'failed') toast.error(r.meaning ?? r.safaricomSaid ?? copy.error.generic);
    }
  }).catch(() => {}), [toast]);
  useEvents(useCallback((e) => { const p = e.payload as { id?: string }; if (e.type === 'request.updated' && pending && p.id === pending) void reload(pending); }, [pending, reload]), pending !== null, useCallback(() => { if (pending) void reload(pending); }, [pending, reload]));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => reload(pending), 15_000);
    return () => clearInterval(t);
  }, [pending, reload]);
  const ask = async () => {
    setLookupErr(null); setLookup(null); setAskedFor(receiptTyped);
    try { const r = await api.post<{ requestId: string }>('/api/lookup', { receipt: receiptTyped }); setPending(r.requestId); toast.info(copy.lookup.asking); }
    catch (e) { setLookupErr(explainApiError(e)); }
  };
  const explained = lookup?.status === 'failed' && lookup.safaricomSaid && lookup.meaning && lookup.whatToDo ? { safaricomSaid: lookup.safaricomSaid, meaning: lookup.meaning, whatToDo: lookup.whatToDo } : null;
  const notHere = loaded && isReceipt && !items.some((r) => r.receipt === receiptTyped);
  const showLookup = askedFor === receiptTyped && (pending || lookup || lookupErr);
  const params = useCallback((c?: string | null) => {
    const p = new URLSearchParams();
    p.set('limit', String(PAGE));
    if (q.trim()) p.set('q', q.trim()); if (from) p.set('from', from); if (to) p.set('to', to); if (status) p.set('status', status); if (direction && DIRECTION_TYPES[direction]) p.set('type', DIRECTION_TYPES[direction]); if (c) p.set('cursor', c);
    return p.toString();
  }, [q, from, to, status, direction]);
  // A filter change starts again from the first page.
  useEffect(() => { setStack([]); }, [q, from, to, status, direction]);
  useEffect(() => {
    const t = setTimeout(() => { api.get<Page<RequestView>>(`/api/requests?${params(cursor)}`).then((r) => { setItems(r.items); setNext(r.nextCursor); setLoaded(true); }).catch(() => setLoaded(true)); }, 200);
    return () => clearTimeout(t);
  }, [params, cursor]);
  const control = 'min-h-10 rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  return (
    <>
      <PageHeader title={copy.history.title} safaricom={copy.history.safaricom} />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-4 py-3">
          <input aria-label={copy.history.search} placeholder={copy.history.searchPlaceholder} className={`${control} min-w-52 flex-1`} value={q} onChange={(e) => setQ(e.target.value)} />
          <input aria-label={copy.history.from} type="date" className={control} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input aria-label={copy.history.to} type="date" className={control} value={to} onChange={(e) => setTo(e.target.value)} />
          <select aria-label={copy.history.direction} className={control} value={direction} onChange={(e) => setDirection(e.target.value)}>
            {Object.entries(copy.history.directions).map(([k, label]) => <option key={k} value={k === 'all' ? '' : k}>{label}</option>)}
          </select>
          <select aria-label={copy.history.status} className={control} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{copy.history.any}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{copy.request.status[s] ?? s}</option>)}
          </select>
        </div>
        {notHere && (
          <div className="border-b border-line p-4">
            <Flash tone="neutral">
              <p>{copy.lookup.notHere}</p>
              {!showLookup && <div className="pt-1"><Button type="button" onClick={() => void ask()}>{copy.lookup.ask}</Button></div>}
              {showLookup && pending && !lookup && <p role="status" className="text-sm text-muted">{copy.lookup.asking}</p>}
            </Flash>
            {showLookup && lookupErr && <div className="mt-3"><ErrorCard error={lookupErr} /></div>}
            {showLookup && lookup?.status === 'completed' && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-surface p-4 text-base">
                <dt className="text-muted">{copy.lookup.says}</dt><dd>{lookup.meaning}</dd>
                <dt className="text-muted">{copy.request.receipt}</dt><dd><code>{lookup.receipt}</code></dd>
                <dt className="text-muted">{copy.request.amount}</dt><dd>{money(lookup.amountCents)}</dd>
                {lookup.recipient.name && <><dt className="text-muted">{copy.request.to}</dt><dd>{lookup.recipient.name}</dd></>}
              </dl>
            )}
            {showLookup && explained && <div className="mt-3"><ErrorCard error={explained} /></div>}
            {showLookup && lookup?.status === 'failed' && !explained && <div className="mt-3"><ErrorCard error={new Error(lookup.meaning ?? lookup.safaricomSaid ?? copy.error.generic)} /></div>}
            {showLookup && lookup?.status === 'unknown' && <p role="alert" className="mt-3 text-base">{copy.lookup.noAnswer}</p>}
          </div>
        )}
        {loaded && items.length === 0 && !notHere && <p className="p-4 text-base text-muted">{copy.history.empty}</p>}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead><tr className="text-left text-sm text-muted">
                {Object.values(copy.history.columns).map((c) => <th key={c} className="px-4 py-2 font-medium">{c}</th>)}
              </tr></thead>
              <tbody>{items.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-4 py-3 whitespace-nowrap">{when(r.createdAt)}</td>
                  <td className="px-4 py-3">{r.category ?? copy.request.subtype[r.subtype ?? ''] ?? copy.request.type[r.type] ?? r.type}</td>
                  <td className="px-4 py-3"><Link to={`/requests/${r.id}`}>{r.recipient.kind === 'phone' ? phone(r.recipient.value) : r.recipient.value ?? '—'}</Link>{r.recipient.name && <span className="block text-sm text-muted">{r.recipient.name}</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{money(r.amountCents)}</td>
                  <td className="px-4 py-3"><StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{copy.request.status[r.status] ?? r.status}</StatusPill></td>
                  <td className="px-4 py-3"><code className="text-sm">{r.receipt ?? '—'}</code></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {(stack.length > 0 || next) && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button type="button" variant="secondary" disabled={stack.length === 0} onClick={() => setStack((s) => s.slice(0, -1))}>{copy.history.previous}</Button>
          <span className="text-sm text-muted">{copy.history.page(stack.length + 1)}</span>
          <Button type="button" variant="secondary" disabled={!next} onClick={() => { if (next) setStack((s) => [...s, next]); }}>{copy.history.next}</Button>
        </div>
      )}
    </>
  );
}
