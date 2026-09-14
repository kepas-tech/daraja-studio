import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { Page, RequestView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
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
  return (
    <>
      <PageHeader title={copy.history.title} safaricom={copy.history.safaricom} />
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <TextField label={copy.history.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <TextField label={copy.history.from} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label={copy.history.to} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <label className="block"><span className="mb-1 block text-base">{copy.history.status}</span>
          <select className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base dark:border-gray-700 dark:bg-gray-900" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{copy.history.any}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{copy.request.status[s] ?? s}</option>)}
          </select></label>
      </div>
      {loaded && items.length === 0 && <p className="text-base">{copy.history.empty}</p>}
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <table className="w-full text-base">
            <thead><tr className="text-left text-sm text-gray-600 dark:text-gray-400">
              {Object.values(copy.history.columns).map((c) => <th key={c} className="px-4 py-2 font-medium">{c}</th>)}
            </tr></thead>
            <tbody>{items.map((r) => (
              <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                <td className="px-4 py-2">{when(r.createdAt)}</td>
                <td className="px-4 py-2">{copy.request.subtype[r.subtype ?? ''] ?? copy.request.type[r.type] ?? r.type}</td>
                <td className="px-4 py-2"><Link className="underline" to={`/requests/${r.id}`}>{r.recipient.kind === 'phone' ? phone(r.recipient.value) : r.recipient.value ?? '—'}</Link>{r.recipient.name && <span className="block text-sm text-gray-500">{r.recipient.name}</span>}</td>
                <td className="px-4 py-2">{money(r.amountCents)}</td>
                <td className="px-4 py-2"><StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{copy.request.status[r.status] ?? r.status}</StatusPill></td>
                <td className="px-4 py-2">{r.receipt ? <code>{r.receipt}</code> : '—'}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {cursor && <div className="mt-4"><Button type="button" variant="secondary" onClick={() => void more()}>{copy.history.loadMore}</Button></div>}
    </>
  );
}
