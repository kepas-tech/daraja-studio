import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api/client';
import { useEvents } from '../api/events';
import type { BulkCheck, BulkPlanView, BusinessView, ContactView, SendCategory } from '../api/types';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { MoneyInput } from '../components/MoneyInput';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { Segmented } from '../components/Segmented';
import { StatusPill } from '../components/StatusPill';
import { STATUS_TONE } from '../components/RequestCard';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import { useStepUp } from './settings/useStepUp';

const TEMPLATE = 'phone,amount,name,note\n0712345678,1500,Jane Doe,September rent\n0722000000,250,John,';

/**
 * A batch is checked in full before anything moves, then sent one row at a time down the same
 * path a single send takes. The page is the list of batches and the form for a new one.
 */
export function Bulk() {
  const c = copy.bulk;
  const toast = useToast();
  const nav = useNavigate();
  const stepUp = useStepUp();
  const [items, setItems] = useState<Omit<BulkPlanView, 'rows'>[] | null>(null);
  const [text, setText] = useState('');
  const [check, setCheck] = useState<BulkCheck | null>(null);
  // Feature 2: the business the batch belongs to. Hidden while there is one; the last used is default.
  const [businesses, setBusinesses] = useState<BusinessView[]>([]);
  const [businessId, setBusinessId] = useState('');
  useEffect(() => {
    api.get<{ items: BusinessView[]; lastUsedId: string | null }>('/api/businesses').then((r) => {
      const live = r.items.filter((b) => b.active);
      setBusinesses(live);
      setBusinessId((id) => id || (live.some((b) => b.id === r.lastUsedId) ? (r.lastUsedId as string) : (live[0]?.id ?? '')));
    }).catch(() => {});
  }, []);
  const [categories, setCategories] = useState<SendCategory[]>([]);
  const [category, setCategory] = useState('');
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [busy, setBusy] = useState(false);
  // The saved phone contacts, so a batch can be built from names. Reading them needs no permission:
  // the picker must work for whoever may send (design 2026-09-16).
  const [contacts, setContacts] = useState<ContactView[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, number | null>>({});

  const load = useCallback(() => api.get<{ items: Omit<BulkPlanView, 'rows'>[] }>('/api/send/bulk').then((r) => setItems(r.items)), []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEffect(() => { api.get<{ items: SendCategory[] }>('/api/send/categories').then((r) => { setCategories(r.items); setCategory((k) => k || r.items[0]?.name || ''); }).catch(() => {}); }, []);
  useEffect(() => { api.get<{ items: ContactView[] }>('/api/contacts?kind=phone').then((r) => setContacts(r.items)).catch(() => setContacts([])); }, []);
  useEvents(useCallback((e) => { if (e.type === 'bulk.updated') void load().catch(() => {}); }, [load]));

  const onFile = async (f: File | null) => { if (f) setText(await f.text()); };
  const lineFor = (x: ContactView) => { const cents = amounts[x.id]; return cents == null ? null : [x.phone, cents / 100, x.name].join(','); };
  const pickedLines = (contacts ?? []).filter((x) => chosen.includes(x.id)).map(lineFor).filter((l): l is string => l !== null);
  // The pasted list stays the one input a batch comes from: this only appends lines to it, so the
  // check and send paths below are unchanged.
  const appendPicked = () => {
    if (pickedLines.length === 0) return;
    setText((t) => (t.trim() ? t.replace(/\s+$/, '') + '\n' : '') + pickedLines.join('\n'));
    setChosen([]); setAmounts({}); setCheck(null);
  };
  const run = async () => {
    setBusy(true); setErr(null); setCheck(null);
    try { setCheck(await api.post<BulkCheck>('/api/send/bulk/check', { text })); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  const send = () => check && stepUp.ask(c.confirm(check.count, money(check.totalCents)), async (password) => {
    const plan = await api.post<BulkPlanView>('/api/send/bulk', { text, category: category || undefined, businessId: businessId || undefined, password });
    toast.success(c.queued);
    nav(`/bulk/${plan.id}`);
  });
  const ready = !!check && check.errors.length === 0 && check.count > 0;

  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom} />
      <div className="space-y-6">
        {contacts && contacts.length > 0 && (
          <Card title={c.fromContacts.title} bodyClassName="space-y-3 p-4">
            <p className="text-base text-muted">{c.fromContacts.intro}</p>
            <ul className="space-y-3">
              {contacts.map((x) => (
                <li key={x.id} className="flex flex-wrap items-end gap-3">
                  <label className="flex min-h-11 items-center gap-2 text-base">
                    <input type="checkbox" className="size-5" checked={chosen.includes(x.id)} onChange={(e) => setChosen((ids) => (e.target.checked ? [...ids, x.id] : ids.filter((id) => id !== x.id)))} />
                    <span>{x.name}<span className="block text-sm text-muted">{phone(x.phone)}</span></span>
                  </label>
                  <MoneyInput label={c.fromContacts.amountFor(x.name)} labelHidden wholeShillings valueCents={amounts[x.id] ?? null} onChange={(v) => setAmounts((a) => ({ ...a, [x.id]: v }))} />
                </li>
              ))}
            </ul>
            <Button type="button" variant="secondary" disabled={pickedLines.length === 0} onClick={appendPicked}>{c.fromContacts.add}</Button>
          </Card>
        )}
        <Card title={c.newBatch} bodyClassName="space-y-4 p-4">
          <p className="text-base text-muted">{c.intro}</p>
          <label className="block">
            <span className="mb-1 block text-base font-medium">{c.paste}</span>
            <textarea aria-label={c.paste} className="min-h-40 w-full rounded-md border border-line bg-surface p-3 font-mono text-sm text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand" value={text} onChange={(e) => { setText(e.target.value); setCheck(null); }} placeholder={TEMPLATE} spellCheck={false} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-page px-4 font-semibold text-ink hover:bg-line/60">
              {c.upload}<input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
            </label>
            <a className="text-sm" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="bulk-send-template.csv">{c.template}</a>
            <Button type="button" variant="secondary" disabled={busy || !text.trim()} onClick={() => void run()}>{busy ? c.checking : c.check}</Button>
          </div>
          {check && (
            <div className="space-y-3">
              <Flash tone={check.errors.length ? 'danger' : 'success'} role="status">{check.errors.length ? c.problems(check.errors.length) : c.ok(check.count, money(check.totalCents))}</Flash>
              {check.errors.length > 0 && (
                <ul className="space-y-1 text-sm text-danger">{check.errors.map((e) => <li key={`${e.line}-${e.message}`}>{c.line(e.line)} {e.message}</li>)}</ul>
              )}
              {check.rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-base">
                    <thead><tr className="text-left text-sm text-muted"><th className="px-3 py-2 font-medium">{c.columns.phone}</th><th className="px-3 py-2 font-medium">{c.columns.name}</th><th className="px-3 py-2 font-medium">{c.columns.amount}</th><th className="px-3 py-2 font-medium">{c.columns.note}</th></tr></thead>
                    <tbody>{check.rows.map((r) => (
                      <tr key={r.line} className="border-t border-line"><td className="px-3 py-2 whitespace-nowrap">{phone(r.phone)}</td><td className="px-3 py-2">{r.name ?? '—'}</td><td className="px-3 py-2 whitespace-nowrap">{money(r.amountCents)}</td><td className="px-3 py-2">{r.note ?? ''}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {ready && categories.length > 0 && <Segmented name="bulk-category" label={copy.send.phone.kind} value={category} options={categories.map((k) => ({ value: k.name, label: k.name }))} onChange={setCategory} />}
              {ready && businesses.length > 1 && (
                <label className="block">
                  <span className="mb-1 block text-base font-medium">{c.business}</span>
                  <select aria-label={c.business} className="min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink" value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
                    {businesses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
                  </select>
                </label>
              )}
              {ready && <Button type="button" onClick={send}>{c.send}</Button>}
            </div>
          )}
          <ErrorCard error={err} />
        </Card>
        <Card title={c.batches} bodyClassName="p-0">
          {!items ? <div className="p-4"><Loading /></div> : items.length === 0 ? <p className="p-4 text-base text-muted">{c.none}</p> : (
            <ul>{items.map((b) => (
              <li key={b.id} className={`${cardRow} flex flex-wrap items-center justify-between gap-2`}>
                <span className="min-w-0"><Link to={`/bulk/${b.id}`} className="font-medium">{c.batchName(b.rowCount, money(b.totalCents))}</Link><span className="block text-sm text-muted">{when(b.createdAt)}{b.createdBy ? ` · ${b.createdBy.displayName}` : ''}</span></span>
                <StatusPill kind={b.status === 'done' ? 'ok' : b.status === 'partly_done' ? 'bad' : 'warn'}>{c.status[b.status]}</StatusPill>
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}

export function BulkDetail() {
  const c = copy.bulk;
  const { id } = useParams();
  const toast = useToast();
  const stepUp = useStepUp();
  const [plan, setPlan] = useState<BulkPlanView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const load = useCallback(() => api.get<BulkPlanView>(`/api/send/bulk/${id}`).then(setPlan), [id]);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'bulk.updated' || e.type === 'request.updated') void load().catch(() => {}); }, [load]));
  if (!plan) return <><PageHeader title={c.title} />{err ? <ErrorCard error={err} /> : <Loading />}</>;
  const retriable = plan.rows.some((r) => r.result?.status === 'failed' && r.result.retriable !== false && !r.result.requestId);
  const csv = ['phone,name,amount,status,receipt', ...plan.rows.map((r) => [phone(r.phone), r.name ?? '', plan.rows.length ? r.amountCents / 100 : 0, r.liveStatus ?? r.result?.status ?? 'queued', r.receipt ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  return (
    <>
      <PageHeader title={c.batchName(plan.rowCount, money(plan.totalCents))} safaricom={c.safaricom}>
        <StatusPill kind={plan.status === 'done' ? 'ok' : plan.status === 'partly_done' ? 'bad' : 'warn'}>{c.status[plan.status]}</StatusPill>
      </PageHeader>
      <p className="mb-4 text-sm text-muted"><Link to="/bulk">{c.back}</Link> · {when(plan.createdAt)}{plan.category ? ` · ${plan.category}` : ''}</p>
      <ErrorCard error={err} />
      <Card bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead><tr className="text-left text-sm text-muted"><th className="px-4 py-2 font-medium">{c.columns.phone}</th><th className="px-4 py-2 font-medium">{c.columns.name}</th><th className="px-4 py-2 font-medium">{c.columns.amount}</th><th className="px-4 py-2 font-medium">{c.columns.status}</th><th className="px-4 py-2 font-medium">{copy.history.columns.receipt}</th></tr></thead>
            <tbody>{plan.rows.map((r) => {
              const st = r.liveStatus ?? (r.result?.status ?? 'queued');
              return (
                <tr key={r.index} className="border-t border-line">
                  <td className="px-4 py-3 whitespace-nowrap">{r.result?.requestId ? <Link to={`/requests/${r.result.requestId}`}>{phone(r.phone)}</Link> : phone(r.phone)}</td>
                  <td className="px-4 py-3">{r.name ?? '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{money(r.amountCents)}</td>
                  <td className="px-4 py-3"><StatusPill kind={st === 'queued' ? 'muted' : STATUS_TONE[st] ?? 'muted'}>{st === 'queued' ? c.queuedRow : copy.request.status[st] ?? st}</StatusPill>{r.result?.error && <span className="block text-sm text-danger">{r.result.error}</span>}</td>
                  <td className="px-4 py-3"><code className="text-sm">{r.receipt ?? '—'}</code></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </Card>
      <div className="mt-4 flex flex-wrap gap-2">
        {retriable && plan.status !== 'sending' && <Button type="button" onClick={() => stepUp.ask(c.confirmRetry, async (password) => { setPlan(await api.post<BulkPlanView>(`/api/send/bulk/${plan.id}/retry`, { password })); toast.success(c.queued); })}>{c.retry}</Button>}
        <a className="inline-flex min-h-11 items-center rounded-md border border-line bg-page px-4 font-semibold text-ink hover:bg-line/60 hover:no-underline" href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`} download={`bulk-${plan.id.slice(0, 8)}.csv`}>{c.download}</a>
      </div>
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
