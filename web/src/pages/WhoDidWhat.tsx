import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { copy } from '../copy/en';
import { when } from '../format';
import type { AuditRow, Page, PersonView } from '../api/types';

/** The rows one fetch shows. The server caps this at 100 and defaults to 25. */
const PAGE = 25;

/** The stored JSON, exactly as it was written: null is its own line, never an empty box. */
function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted">{copy.whoDidWhat.nothing}</span>;
  return <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-surface p-3 text-sm">{JSON.stringify(value, null, 2)}</pre>;
}

/**
 * Feature 10. The studio's own record of what was done: settings changed, operators rotated,
 * payments held and released, people added. Read-only — the table it reads refuses every write —
 * and owner only, so the two filter lists below are the owner's own people and actions.
 */
export function WhoDidWhat() {
  const [q, setQ] = useState(''); const [personId, setPersonId] = useState(''); const [action, setAction] = useState('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const [people, setPeople] = useState<PersonView[]>([]); const [actions, setActions] = useState<string[]>([]);
  const [items, setItems] = useState<AuditRow[]>([]); const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); const [err, setErr] = useState<Error | Explained | null>(null);
  /** Which row has its before and after open; one at a time keeps the table readable. */
  const [open, setOpen] = useState<string | null>(null);
  // Keyset paging is forward-only on the server; Previous is the stack of cursors we came through.
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1] ?? null;

  // The two lists the filters offer. A refusal is not the page's own error: it still reads what it can.
  useEffect(() => {
    api.get<PersonView[]>('/api/people').then(setPeople).catch(() => setPeople([]));
    api.get<{ items: string[] }>('/api/audit/actions').then((r) => setActions(r.items)).catch(() => setActions([]));
  }, []);

  const params = useCallback((c?: string | null) => {
    const p = new URLSearchParams();
    p.set('limit', String(PAGE));
    if (personId) p.set('personId', personId);
    if (action) p.set('action', action);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (q.trim()) p.set('q', q.trim());
    if (c) p.set('cursor', c);
    return p.toString();
  }, [q, personId, action, from, to]);

  // A filter change starts again from the first page.
  useEffect(() => { setStack([]); }, [q, personId, action, from, to]);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get<Page<AuditRow>>(`/api/audit?${params(cursor)}`)
        .then((r) => { setItems(r.items); setNext(r.nextCursor); setErr(null); setLoaded(true); })
        .catch((e) => { setItems([]); setNext(null); setErr(explainApiError(e)); setLoaded(true); });
    }, 200);
    return () => clearTimeout(t);
  }, [params, cursor]);

  const control = 'min-h-10 rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  const cell = 'px-4 py-3 align-top';
  const th = 'px-4 py-2 text-left font-medium';
  return (
    <>
      <PageHeader title={copy.whoDidWhat.title} />
      <p className="mb-4 max-w-2xl text-base text-muted">{copy.whoDidWhat.intro}</p>
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-4 py-3">
          <input aria-label={copy.whoDidWhat.search} placeholder={copy.whoDidWhat.searchPlaceholder} className={`${control} min-w-52 flex-1`} value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label={copy.whoDidWhat.person} className={control} value={personId} onChange={(e) => setPersonId(e.target.value)}>
            <option value="">{copy.whoDidWhat.anyPerson}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
          <select aria-label={copy.whoDidWhat.action} className={control} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{copy.whoDidWhat.anyAction}</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <input aria-label={copy.whoDidWhat.from} type="date" className={control} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input aria-label={copy.whoDidWhat.to} type="date" className={control} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {err && <div className="border-b border-line p-4"><ErrorCard error={err} /></div>}
        {!loaded && !err && <Loading />}
        {loaded && !err && items.length === 0 && <p className="p-4 text-base text-muted">{copy.whoDidWhat.empty}</p>}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <caption className="sr-only">{copy.whoDidWhat.tableCaption}</caption>
              <thead><tr className="text-sm text-muted">
                <th className={th}>{copy.whoDidWhat.columns.when}</th>
                <th className={th}>{copy.whoDidWhat.columns.who}</th>
                <th className={th}>{copy.whoDidWhat.columns.what}</th>
                <th className={th}>{copy.whoDidWhat.columns.target}</th>
                <th className={th}><span className="sr-only">{copy.whoDidWhat.show}</span></th>
              </tr></thead>
              <tbody>{items.map((r) => (
                <Fragment key={r.id}>
                  <tr className="border-t border-line" data-testid={`audit-${r.id}`}>
                    <td className={`${cell} whitespace-nowrap`}>{when(r.at)}</td>
                    <td className={cell}>{r.person ? r.person.displayName : <span className="text-muted">{copy.whoDidWhat.nobody}</span>}</td>
                    <td className={cell}><code className="text-sm">{r.action}</code></td>
                    <td className={cell}>{r.target ?? '—'}</td>
                    <td className={`${cell} text-right`}>
                      <Button type="button" variant="secondary" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                        {open === r.id ? copy.whoDidWhat.hide : copy.whoDidWhat.show}
                      </Button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="border-t border-line bg-page">
                      <td className={cell} colSpan={5}>
                        <dl className="grid gap-3 md:grid-cols-2">
                          <div><dt className="text-sm text-muted">{copy.whoDidWhat.before}</dt><dd><Json value={r.before} /></dd></div>
                          <div><dt className="text-sm text-muted">{copy.whoDidWhat.after}</dt><dd><Json value={r.after} /></dd></div>
                          <div><dt className="text-sm text-muted">{copy.whoDidWhat.address}</dt><dd>{r.ip ?? copy.whoDidWhat.noAddress}</dd></div>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {(stack.length > 0 || next) && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button type="button" variant="secondary" disabled={stack.length === 0} onClick={() => setStack((s) => s.slice(0, -1))}>{copy.whoDidWhat.previous}</Button>
          <span className="text-sm text-muted">{copy.whoDidWhat.page(stack.length + 1)}</span>
          <Button type="button" variant="secondary" disabled={!next} onClick={() => { if (next) setStack((s) => [...s, next]); }}>{copy.whoDidWhat.next}</Button>
        </div>
      )}
    </>
  );
}
