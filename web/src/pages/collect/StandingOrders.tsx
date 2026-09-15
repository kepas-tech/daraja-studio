import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../../api/client';
import type { Page, RequestView } from '../../api/types';
import { Button } from '../../components/Button';
import { Card, cardRow } from '../../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { MoneyInput } from '../../components/MoneyInput';
import { PageHeader } from '../../components/PageHeader';
import { PhoneInput } from '../../components/PhoneInput';
import { Questionnaire } from '../../components/Questionnaire';
import { RequestCard, STATUS_TONE } from '../../components/RequestCard';
import { StatusPill } from '../../components/StatusPill';
import { TaskCard } from '../../components/TaskCard';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { money, normalizeKe, phone, when } from '../../format';
import { useCollectResult } from './useCollectResult';

const FREQUENCIES = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;
type Frequency = (typeof FREQUENCIES)[number];
type Step = 'list' | 'form' | 'review' | 'result';
const control = 'min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';

/** A customer's standing order: they consent once on their phone, Safaricom collects on schedule. Nothing can be changed afterwards. */
export function StandingOrders() {
  const c = copy.standingOrders;
  const toast = useToast();
  const [step, setStep] = useState<Step>('list');
  const [items, setItems] = useState<RequestView[] | null>(null);
  const [f, setF] = useState({ name: '', phone: '', frequency: '4' as Frequency, startDate: '', endDate: '', accountReference: '', transactionDesc: '' });
  const [cents, setCents] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const { request, setRequest } = useCollectResult();
  const load = useCallback(() => api.get<Page<RequestView>>('/api/requests?type=ratiba&limit=50').then((p) => setItems(p.items)), []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEffect(() => { if (request && request.status !== 'sent') void load().catch(() => {}); }, [request, load]);
  const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const valid = f.name.trim().length > 0 && !!normalizeKe(f.phone) && cents !== null && cents % 100 === 0 && day(f.startDate) && day(f.endDate) && f.endDate >= f.startDate && f.accountReference.trim().length > 0;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<RequestView>('/api/collect/ratiba', { name: f.name.trim(), phone: f.phone, amountCents: cents, frequency: f.frequency, startDate: f.startDate, endDate: f.endDate, accountReference: f.accountReference.trim(), transactionDesc: f.transactionDesc.trim(), transactionType: 'paybill' });
      setRequest(r); setStep('result'); toast.info(c.result.sent);
    } catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  const reset = () => { setStep('list'); setF({ name: '', phone: '', frequency: '4', startDate: '', endDate: '', accountReference: '', transactionDesc: '' }); setCents(null); setRequest(null); setErr(null); };
  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom}>{step === 'list' && <Button onClick={() => setStep('form')}>{c.new}</Button>}</PageHeader>
      {step === 'list' && (
        <Card bodyClassName="p-0">
          <p className="border-b border-line px-4 py-3 text-base text-muted">{c.intro}</p>
          {err && <div className="p-4"><ErrorCard error={err} /></div>}
          {!items ? null : items.length === 0 ? <p className="p-4 text-base text-muted">{c.empty}</p> : (
            <ul>{items.map((r) => (
              <li key={r.id} className={`${cardRow} flex flex-wrap items-center gap-3`}>
                <span className="min-w-0 flex-1"><Link to={`/requests/${r.id}`} className="font-medium">{r.remarks ?? c.title}</Link><span className="block text-sm text-muted">{phone(r.recipient.value)} · {money(r.amountCents)} · {when(r.createdAt)}</span></span>
                <StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{r.status === 'completed' ? c.active : copy.request.status[r.status] ?? r.status}</StatusPill>
              </li>
            ))}</ul>
          )}
        </Card>
      )}
      {step === 'form' && (
        <Questionnaire intro={c.formIntro} doneLabel={c.review} onCancel={reset} onDone={() => { if (valid) setStep('review'); }} steps={[
          { key: 'name', question: c.name, hint: c.nameHint, valid: f.name.trim().length > 0, render: () => <TextField label={c.name} labelHidden value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} autoFocus /> },
          { key: 'phone', question: c.phone, valid: !!normalizeKe(f.phone), render: () => <PhoneInput label={c.phone} labelHidden value={f.phone} onChange={(v) => setF({ ...f, phone: v })} autoFocus /> },
          { key: 'amount', question: c.amount, valid: cents !== null && cents % 100 === 0, render: () => <MoneyInput label={c.amount} labelHidden valueCents={cents} onChange={setCents} wholeShillings autoFocus /> },
          { key: 'frequency', question: c.frequency, valid: true, render: () => <select aria-label={c.frequency} className={control} value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as Frequency })}>{FREQUENCIES.map((k) => <option key={k} value={k}>{c.frequencies[k]}</option>)}</select> },
          { key: 'start', question: c.startDate, valid: day(f.startDate), render: () => <TextField label={c.startDate} labelHidden type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} autoFocus /> },
          { key: 'end', question: c.endDate, valid: day(f.endDate) && f.endDate >= f.startDate, render: () => <TextField label={c.endDate} labelHidden type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} autoFocus /> },
          { key: 'account', question: c.account, hint: c.accountHint, valid: f.accountReference.trim().length > 0 && f.accountReference.trim().length <= 12, render: () => <TextField label={c.account} labelHidden value={f.accountReference} onChange={(e) => setF({ ...f, accountReference: e.target.value })} maxLength={12} autoFocus /> },
          { key: 'note', question: c.note, hint: c.noteHint, optional: true, valid: true, empty: !f.transactionDesc, render: () => <TextField label={c.note} labelHidden value={f.transactionDesc} onChange={(e) => setF({ ...f, transactionDesc: e.target.value })} maxLength={13} autoFocus /> },
        ]} />
      )}
      {step === 'review' && (
        <TaskCard footerStart={<Button type="button" variant="secondary" onClick={() => setStep('form')}>{copy.questionnaire.back}</Button>} footer={<Button type="button" disabled={busy} onClick={() => void submit()}>{c.create}</Button>}>
          <h2 className="text-xl font-semibold">{c.reviewTitle}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
            <dt className="text-muted">{c.name}</dt><dd>{f.name.trim()}</dd>
            <dt className="text-muted">{c.phone}</dt><dd>{phone(normalizeKe(f.phone))}</dd>
            <dt className="text-muted">{c.amount}</dt><dd>{money(cents)}</dd>
            <dt className="text-muted">{c.frequency}</dt><dd>{c.frequencies[f.frequency]}</dd>
            <dt className="text-muted">{c.startDate}</dt><dd>{f.startDate}</dd>
            <dt className="text-muted">{c.endDate}</dt><dd>{f.endDate}</dd>
            <dt className="text-muted">{c.account}</dt><dd>{f.accountReference.trim()}</dd>
          </dl>
          <Flash tone="neutral">{c.fixedNote}</Flash>
          <ErrorCard error={err} />
        </TaskCard>
      )}
      {step === 'result' && request && (
        <div className="max-w-xl space-y-4">
          <p role="status" className="text-lg font-semibold">{c.result[request.status as 'sent' | 'completed' | 'failed' | 'unknown'] ?? request.status}</p>
          {request.status === 'sent' && <p className="text-base text-muted">{c.waiting}</p>}
          <RequestCard request={request}><Button type="button" onClick={reset}>{c.done}</Button></RequestCard>
        </div>
      )}
    </>
  );
}
