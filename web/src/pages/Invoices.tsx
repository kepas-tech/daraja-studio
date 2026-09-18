import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, saveDownload } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import type { BusinessTypeView, InvoiceView, InvoicesSettingsView } from '../api/types';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { SafaricomHow } from '../components/SafaricomHow';
import { how } from '../copy/guide';
import { Loading } from '../components/Loading';
import { MoneyInput } from '../components/MoneyInput';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { PhoneInput } from '../components/PhoneInput';
import { Questionnaire } from '../components/Questionnaire';
import { AccountPicker } from '../components/AccountPicker';
import { expectationLines } from '../businessTypes';
import { Segmented } from '../components/Segmented';
import { StatusPill } from '../components/StatusPill';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, normalizeKe, phone, when } from '../format';
import { useStepUp } from './settings/useStepUp';

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = { sent: 'warn', partly_paid: 'warn', paid: 'ok', overdue: 'bad', cancelled: 'muted' };
const control = 'min-h-10 rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
const TEMPLATE = 'name,phone,invoice name,account,period,due date,amount\nJane Doe,0712345678,September rent,HSE-12,September 2026,2026-09-30,15000';

/** First visit: opt in with Safaricom. After that: the list, a new invoice, a bulk list. */
export function Invoices() {
  const c = copy.invoices;
  const toast = useToast();
  const nav = useNavigate();
  const { person, permissions } = useSession();
  const stepUp = useStepUp();
  const [settings, setSettings] = useState<InvoicesSettingsView | null>(null);
  const [items, setItems] = useState<InvoiceView[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'overdue' | 'paid' | 'cancelled' | 'all'>('open');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'list' | 'new' | 'bulk'>('list');
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // Feature 3: an accountant asks for a month of invoices; the file holds every row the filter and
  // the search select, not the page on screen. Owner, or whoever was given history.export.
  const mayExport = !!person?.is_owner || permissions.includes('history.export');
  const [exporting, setExporting] = useState(false);

  const loadSettings = useCallback(() => api.get<InvoicesSettingsView>('/api/invoices/settings').then(setSettings), []);
  const loadList = useCallback(() => api.get<{ items: InvoiceView[] }>(`/api/invoices?filter=${filter}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => setItems(r.items)), [filter, q]);
  useEffect(() => { loadSettings().catch((e) => setErr(explainApiError(e))); }, [loadSettings]);
  useEffect(() => { const t = setTimeout(() => { loadList().catch((e) => setErr(explainApiError(e))); }, 200); return () => clearTimeout(t); }, [loadList]);
  const exportFile = async () => {
    setExporting(true); setErr(null);
    try {
      saveDownload(await api.download(`/api/invoices/export.csv?filter=${filter}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`), 'invoices.csv');
      toast.success(c.exported);
    } catch (e) { setErr(explainApiError(e)); toast.error(copy.error.exportFailed); }
    finally { setExporting(false); }
  };
  useEvents(useCallback((e) => {
    if (e.type === 'invoice.updated' || e.type === 'request.updated') void loadList().catch(() => {});
    if (e.type === 'invoice.updated') void loadSettings().catch(() => {});
  }, [loadList, loadSettings]));
  // While Safaricom is being told, re-read every few seconds in case the event stream is down.
  useEffect(() => {
    if (!settings?.registering) return;
    const t = setInterval(() => { void loadSettings().catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [settings?.registering, loadSettings]);

  if (!settings) return <><PageHeader title={c.title} safaricom={c.safaricom} />{err ? <ErrorCard error={err} /> : <Loading />}</>;
  if (!settings.optedIn) {
    return (
      <>
        <PageHeader title={c.title} safaricom={c.safaricom} />
        {settings.registering && <Flash tone="neutral" role="status" className="mb-4">{c.optIn.registering}</Flash>}
        {!settings.registering && settings.lastError && (
          <Flash tone="danger" role="alert" className="mb-4">
            <p className="font-semibold">{c.optIn.failed}</p>
            {settings.lastError.split('\n').map((line, i) => <p key={i}>{line}</p>)}
            <SafaricomHow links={[how.updateApp, how.apiSupport]} />
          </Flash>
        )}
        {person?.is_owner ? (settings.registering ? null : <OptIn settings={settings} stepUp={stepUp} onDone={() => { void loadSettings(); }} />) : <p className="text-base text-muted">{c.ownerOptsIn}</p>}
        <PasswordConfirmDialog {...stepUp.dialogProps} />
      </>
    );
  }
  const cancelMany = async () => {
    setErr(null);
    try { const r = await api.post<{ cancelled: number }>('/api/invoices/cancel', { ids: selected }); toast.success(c.cancelled(r.cancelled)); setSelected([]); await loadList(); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
  };
  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom}>
        {mode === 'list' && <span className="flex gap-2"><Button variant="secondary" onClick={() => setMode('bulk')}>{c.bulk}</Button><Button onClick={() => setMode('new')}>{c.new}</Button></span>}
      </PageHeader>
      <ErrorCard error={err} />
      {mode === 'new' && <NewInvoice onCancel={() => setMode('list')} onDone={(inv) => { toast.success(c.sent(inv.reference)); setMode('list'); nav(`/invoices/${inv.id}`); }} />}
      {mode === 'bulk' && <BulkInvoices onCancel={() => setMode('list')} onDone={(n) => { toast.success(c.bulkSent(n)); setMode('list'); void loadList(); }} />}
      {mode === 'list' && (
        <Card bodyClassName="p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-4 py-3">
            <input aria-label={c.search} placeholder={c.search} className={`${control} min-w-52 flex-1`} value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label={c.filter} className={control} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              {(['open', 'overdue', 'paid', 'cancelled', 'all'] as const).map((f) => <option key={f} value={f}>{c.filters[f]}</option>)}
            </select>
            {mayExport && <Button type="button" variant="secondary" disabled={exporting} onClick={() => void exportFile()}>{exporting ? c.exporting : c.export}</Button>}
            {selected.length > 0 && <Button variant="danger" onClick={() => void cancelMany()}>{c.cancelSelected(selected.length)}</Button>}
          </div>
          {!items ? <div className="p-4"><Loading /></div> : items.length === 0 ? <p className="p-4 text-base text-muted">{c.empty}</p> : (
            <ul>{items.map((i) => (
              <li key={i.id} className={`${cardRow} flex flex-wrap items-center gap-3`}>
                {i.stored === 'sent' && <input type="checkbox" aria-label={c.select(i.reference)} className="size-5 accent-brand" checked={selected.includes(i.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, i.id] : s.filter((x) => x !== i.id))} />}
                <span className="min-w-0 flex-1">
                  <Link to={`/invoices/${i.id}`} className="font-medium">{i.reference} · {i.customerName}</Link>
                  <span className="block text-sm text-muted">{i.invoiceName} · {c.due(i.dueDate)}{i.paidCents > 0 && i.status !== 'paid' ? ` · ${c.paidSoFar(money(i.paidCents))}` : ''}</span>
                </span>
                <span className="whitespace-nowrap font-medium">{money(i.amountCents)}</span>
                <StatusPill kind={TONE[i.status] ?? 'muted'}>{c.status[i.status]}</StatusPill>
              </li>
            ))}</ul>
          )}
        </Card>
      )}
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}

function OptIn({ settings, stepUp, onDone }: { settings: InvoicesSettingsView; stepUp: ReturnType<typeof useStepUp>; onDone: () => void }) {
  const c = copy.invoices.optIn;
  const [email, setEmail] = useState(settings.email ?? '');
  const [contact, setContact] = useState(settings.phone ?? '');
  const [reminders, setReminders] = useState<'yes' | 'no'>(settings.reminders ? 'yes' : 'no');
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const submit = () => stepUp.ask(c.confirm, async (confirm) => {
    await api.post('/api/invoices/opt-in', { email: email.trim(), officialContact: normalizeKe(contact) ?? contact, sendReminders: reminders === 'yes', ...confirm });
    onDone();
  });
  return (
    <div className="space-y-4">
      {!settings.publicVerified && <Flash tone="neutral">{copy.moneyIn.needsAddress}</Flash>}
      <Questionnaire intro={c.intro} doneLabel={c.button} onDone={submit} steps={[
        { key: 'email', question: c.email, valid: emailOk, render: () => <TextField label={c.email} labelHidden type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /> },
        { key: 'contact', question: c.contact, valid: !!normalizeKe(contact), render: () => <PhoneInput label={c.contact} labelHidden value={contact} onChange={setContact} autoFocus /> },
        { key: 'reminders', question: c.reminders, hint: c.remindersHint, valid: true, render: () => <Segmented name="reminders" label={c.reminders} value={reminders} options={[{ value: 'yes', label: copy.confirm.yes }, { value: 'no', label: copy.confirm.no }]} onChange={setReminders} /> },
      ]} />
    </div>
  );
}

function NewInvoice({ onCancel, onDone }: { onCancel: () => void; onDone: (inv: InvoiceView) => void }) {
  const c = copy.invoices.form;
  const [f, setF] = useState({ customerName: '', customerPhone: '', invoiceName: '', accountReference: '', billedPeriod: '', dueDate: '', items: '', accountId: '' });
  const [cents, setCents] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | Explained | null>(null);
  // Round 3, phase B: the kind of business behind the picked account says what this kind of
  // business does with invoices and reminders.
  const [kind, setKind] = useState<BusinessTypeView | null>(null);
  const items = f.items.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.lastIndexOf(','); const name = i < 0 ? l : l.slice(0, i).trim(); const amt = i < 0 ? NaN : Number(l.slice(i + 1).replace(/,/g, '')); return { name, amountCents: Math.round(amt * 100) }; });
  const itemsOk = items.every((i) => i.name && Number.isFinite(i.amountCents) && i.amountCents > 0);
  const itemsTotal = items.reduce((s, i) => s + (Number.isFinite(i.amountCents) ? i.amountCents : 0), 0);
  const amount = items.length && itemsOk ? itemsTotal : cents;
  const submit = async () => {
    if (busy || amount === null) return;
    setBusy(true); setErr(null);
    try { onDone(await api.post<InvoiceView>('/api/invoices', { ...f, accountId: f.accountId || undefined, items: items.length ? items : undefined, amountCents: amount })); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Questionnaire intro={c.intro} doneLabel={c.send} busy={busy} onCancel={onCancel} onDone={() => void submit()} steps={[
        { key: 'name', question: c.customerName, valid: f.customerName.trim().length > 0, render: () => <TextField label={c.customerName} labelHidden value={f.customerName} onChange={(e) => setF({ ...f, customerName: e.target.value })} autoFocus /> },
        { key: 'phone', question: c.customerPhone, valid: !!normalizeKe(f.customerPhone), render: () => <PhoneInput label={c.customerPhone} labelHidden value={f.customerPhone} onChange={(v) => setF({ ...f, customerPhone: v })} autoFocus /> },
        { key: 'invoice', question: c.invoiceName, valid: f.invoiceName.trim().length > 0, render: () => <TextField label={c.invoiceName} labelHidden value={f.invoiceName} onChange={(e) => setF({ ...f, invoiceName: e.target.value })} autoFocus /> },
        { key: 'account', question: c.accountReference, hint: c.accountHint, valid: f.accountReference.trim().length > 0 && f.accountReference.trim().length <= 20, render: () => (
          <div className="space-y-3">
            <AccountPicker label={c.pickCustomer} onPick={(x, b) => { setKind(b.type); setF((prev) => ({ ...prev, accountId: x.id, accountReference: x.fullNumber, customerName: prev.customerName.trim() || x.name, customerPhone: prev.customerPhone.trim() || (x.phone ?? '') })); }} />
            {kind && <p className="text-sm text-muted" data-testid="invoice-kind">{copy.businesses.kind(kind.name)} · {expectationLines(kind.template).join(' ')}</p>}
            <p className="text-sm text-muted">{c.pickCustomerHint}</p>
            <TextField label={c.accountReference} labelHidden value={f.accountReference} onChange={(e) => setF({ ...f, accountReference: e.target.value })} autoFocus />
          </div>
        ) },
        { key: 'period', question: c.billedPeriod, valid: f.billedPeriod.trim().length > 0, render: () => <TextField label={c.billedPeriod} labelHidden value={f.billedPeriod} onChange={(e) => setF({ ...f, billedPeriod: e.target.value })} autoFocus /> },
        { key: 'due', question: c.dueDate, valid: /^\d{4}-\d{2}-\d{2}$/.test(f.dueDate), render: () => <TextField label={c.dueDate} labelHidden type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} autoFocus /> },
        { key: 'items', question: c.items, hint: c.itemsHint, optional: true, valid: itemsOk, empty: f.items.trim().length === 0, render: () => <label className="block"><span className="sr-only">{c.items}</span><textarea aria-label={c.items} className="min-h-28 w-full rounded-md border border-line bg-surface p-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand" value={f.items} onChange={(e) => setF({ ...f, items: e.target.value })} placeholder={c.itemsPlaceholder} autoFocus /></label> },
        ...(items.length && itemsOk ? [] : [{ key: 'amount', question: c.amount, valid: cents !== null && cents > 0, render: () => <MoneyInput label={c.amount} labelHidden valueCents={cents} onChange={setCents} autoFocus /> }]),
      ]} />
      {items.length > 0 && itemsOk && <p className="text-sm text-muted">{c.itemsTotal(money(itemsTotal))}</p>}
      <ErrorCard error={err} />
    </div>
  );
}

function BulkInvoices({ onCancel, onDone }: { onCancel: () => void; onDone: (n: number) => void }) {
  const c = copy.invoices.bulkForm;
  const [text, setText] = useState('');
  const [check, setCheck] = useState<{ rows: unknown[]; errors: { line: number; message: string }[]; count: number; totalCents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const run = async () => { setBusy(true); setErr(null); try { setCheck(await api.post('/api/invoices/bulk/check', { text })); } catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); } finally { setBusy(false); } };
  const send = async () => { setBusy(true); setErr(null); try { const r = await api.post<{ count: number }>('/api/invoices/bulk', { text }); onDone(r.count); } catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); } finally { setBusy(false); } };
  return (
    <Card title={c.title} bodyClassName="space-y-4 p-4">
      <p className="text-base text-muted">{c.intro}</p>
      <textarea aria-label={c.paste} className="min-h-40 w-full rounded-md border border-line bg-surface p-3 font-mono text-sm text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand" value={text} onChange={(e) => { setText(e.target.value); setCheck(null); }} placeholder={TEMPLATE} spellCheck={false} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-page px-4 font-semibold text-ink hover:bg-line/60">{copy.bulk.upload}<input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => { setText(t); setCheck(null); }); }} /></label>
        <a className="text-sm" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="invoices-template.csv">{copy.bulk.template}</a>
        <Button type="button" variant="secondary" disabled={busy || !text.trim()} onClick={() => void run()}>{copy.bulk.check}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>{copy.confirm.cancel}</Button>
      </div>
      {check && (
        <div className="space-y-3">
          <Flash tone={check.errors.length ? 'danger' : 'success'} role="status">{check.errors.length ? copy.bulk.problems(check.errors.length) : c.ok(check.count, money(check.totalCents))}</Flash>
          {check.errors.length > 0 && <ul className="space-y-1 text-sm text-danger">{check.errors.map((e) => <li key={`${e.line}-${e.message}`}>{copy.bulk.line(e.line)} {e.message}</li>)}</ul>}
          {check.errors.length === 0 && check.count > 0 && <Button type="button" disabled={busy} onClick={() => void send()}>{c.send}</Button>}
        </div>
      )}
      <ErrorCard error={err} />
    </Card>
  );
}

export function InvoiceDetail() {
  const c = copy.invoices;
  const { id } = useParams();
  const toast = useToast();
  const [inv, setInv] = useState<InvoiceView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [recording, setRecording] = useState(false);
  const [pay, setPay] = useState({ paymentDate: '', reference: '', payer: '' });
  const [payCents, setPayCents] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get<InvoiceView>(`/api/invoices/${id}`).then(setInv), [id]);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'invoice.updated' || e.type === 'request.updated') void load().catch(() => {}); }, [load]));
  if (!inv) return <><PageHeader title={c.title} />{err ? <ErrorCard error={err} /> : <Loading />}</>;
  const open = inv.stored === 'sent' || inv.stored === 'partly_paid';
  const cancel = async () => { setBusy(true); setErr(null); try { setInv(await api.post<InvoiceView>(`/api/invoices/${inv.id}/cancel`, {})); toast.success(c.cancelled(1)); } catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); } finally { setBusy(false); } };
  const record = async () => {
    if (payCents === null) return;
    setBusy(true); setErr(null);
    try { setInv(await api.post<InvoiceView>(`/api/invoices/${inv.id}/payment`, { ...pay, amountCents: payCents })); toast.success(c.recorded); setRecording(false); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={`${inv.reference} · ${inv.customerName}`} safaricom={c.safaricom}><StatusPill kind={TONE[inv.status] ?? 'muted'}>{c.status[inv.status]}</StatusPill></PageHeader>
      <p className="mb-4 text-sm text-muted"><Link to="/invoices">{c.back}</Link></p>
      <ErrorCard error={err} />
      <div className="grid gap-6 md:grid-cols-2">
        <Card title={inv.invoiceName} bodyClassName="p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="text-muted">{c.form.customerPhone}</dt><dd>{phone(inv.customerPhone)}</dd>
            <dt className="text-muted">{c.form.accountReference}</dt><dd>{inv.accountReference}</dd>
            <dt className="text-muted">{c.form.billedPeriod}</dt><dd>{inv.billedPeriod}</dd>
            <dt className="text-muted">{c.form.dueDate}</dt><dd>{inv.dueDate}</dd>
            <dt className="text-muted">{c.form.amount}</dt><dd className="font-semibold">{money(inv.amountCents)}</dd>
            <dt className="text-muted">{c.paid}</dt><dd>{money(inv.paidCents)}</dd>
            <dt className="text-muted">{copy.request.when}</dt><dd>{when(inv.sentAt)}</dd>
          </dl>
          {inv.items.length > 0 && <ul className="mt-3 border-t border-line pt-3 text-base">{inv.items.map((it, i) => <li key={i} className="flex justify-between"><span>{it.name}</span><span>{money(it.amountCents)}</span></li>)}</ul>}
          {open && (
            <div className="mt-4 flex flex-wrap gap-2">
              {inv.stored === 'sent' && <Button variant="danger" disabled={busy} onClick={() => void cancel()}>{c.cancel}</Button>}
              {!recording && <Button variant="secondary" onClick={() => setRecording(true)}>{c.record}</Button>}
            </div>
          )}
        </Card>
        <Card title={c.payments} bodyClassName="p-0">
          {inv.payments.length === 0 ? <p className="p-4 text-base text-muted">{c.noPayments}</p> : (
            <ul>{inv.payments.map((p) => <li key={p.id} className={`${cardRow} flex items-center justify-between gap-2`}><span>{when(p.at)}<span className="block text-sm text-muted">{p.source === 'callback' ? c.viaMpesa : c.viaOther}{p.receipt ? ` · ${p.receipt}` : ''}</span></span><span className="font-medium">{money(p.amountCents)}</span></li>)}</ul>
          )}
        </Card>
      </div>
      {recording && (
        <div className="mt-6 max-w-xl">
          <Questionnaire intro={c.recordIntro} doneLabel={c.record} busy={busy} onCancel={() => setRecording(false)} onDone={() => void record()} steps={[
            { key: 'date', question: c.recordDate, valid: /^\d{4}-\d{2}-\d{2}$/.test(pay.paymentDate), render: () => <TextField label={c.recordDate} labelHidden type="date" value={pay.paymentDate} onChange={(e) => setPay({ ...pay, paymentDate: e.target.value })} autoFocus /> },
            { key: 'amount', question: c.recordAmount, valid: payCents !== null && payCents > 0, render: () => <MoneyInput label={c.recordAmount} labelHidden valueCents={payCents} onChange={setPayCents} autoFocus /> },
            { key: 'ref', question: c.recordReference, valid: pay.reference.trim().length > 0, render: () => <TextField label={c.recordReference} labelHidden value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} autoFocus /> },
            { key: 'payer', question: c.recordPayer, optional: true, valid: true, empty: pay.payer.trim().length === 0, render: () => <TextField label={c.recordPayer} labelHidden value={pay.payer} onChange={(e) => setPay({ ...pay, payer: e.target.value })} autoFocus /> },
          ]} />
        </div>
      )}
    </>
  );
}
