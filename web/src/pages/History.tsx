import { useCallback, useEffect, useState } from 'react';
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

const STATUSES = ['completed', 'sent', 'failed', 'unknown', 'pending', 'cancelled'];

export function History() {
  const [q, setQ] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [status, setStatus] = useState('');
  const [items, setItems] = useState<RequestView[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [loaded, setLoaded] = useState(false);
  const params = useCallback((c?: string | null) => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim()); if (from) p.set('from', from); if (to) p.set('to', to); if (status) p.set('status', status); if (c) p.set('cursor', c);
    return p.toString();
  }, [q, from, to, status]);
  useEffect(() => {
    const t = setTimeout(() => { api.get<Page<RequestView>>(`/api/requests?${params()}`).then((r) => { setItems(r.items); setCursor(r.nextCursor); setLoaded(true); }).catch(() => setLoaded(true)); }, 200);
    return () => clearTimeout(t);
  }, [params]);
  const more = () => api.get<Page<RequestView>>(`/api/requests?${params(cursor)}`).then((r) => { setItems((prev) => [...prev, ...r.items]); setCursor(r.nextCursor); }).catch(() => {});
  const control = 'min-h-10 rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  return (
    <>
      <PageHeader title={copy.history.title} safaricom={copy.history.safaricom} />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-4 py-3">
          <input aria-label={copy.history.search} placeholder={copy.history.searchPlaceholder} className={`${control} min-w-52 flex-1`} value={q} onChange={(e) => setQ(e.target.value)} />
          <input aria-label={copy.history.from} type="date" className={control} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input aria-label={copy.history.to} type="date" className={control} value={to} onChange={(e) => setTo(e.target.value)} />
          <select aria-label={copy.history.status} className={control} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{copy.history.any}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{copy.request.status[s] ?? s}</option>)}
          </select>
        </div>
        {loaded && items.length === 0 && <p className="p-4 text-base text-muted">{copy.history.empty}</p>}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead><tr className="text-left text-sm text-muted">
                {Object.values(copy.history.columns).map((c) => <th key={c} className="px-4 py-2 font-medium">{c}</th>)}
              </tr></thead>
              <tbody>{items.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-4 py-3 whitespace-nowrap">{when(r.createdAt)}</td>
                  <td className="px-4 py-3">{copy.request.subtype[r.subtype ?? ''] ?? copy.request.type[r.type] ?? r.type}</td>
                  <td className="px-4 py-3"><Link to={`/requests/${r.id}`}>{r.recipient.kind === 'phone' ? phone(r.recipient.value) : r.recipient.value ?? '—'}</Link>{r.recipient.name && <span className="block text-sm text-muted">{r.recipient.name}</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{money(r.amountCents)}</td>
                  <td className="px-4 py-3"><StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{copy.request.status[r.status] ?? r.status}</StatusPill></td>
                  <td className="px-4 py-3"><code className="text-sm">{r.receipt ?? '—'}</code></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {cursor && <div className="mt-4 flex justify-center"><Button type="button" variant="secondary" onClick={() => void more()}>{copy.history.loadMore}</Button></div>}
    </>
  );
}
