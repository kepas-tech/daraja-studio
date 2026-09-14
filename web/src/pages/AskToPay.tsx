import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api/client';
import { useEvents } from '../api/events';
import type { RequestView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { MoneyInput } from '../components/MoneyInput';
import { PhoneInput } from '../components/PhoneInput';
import { PageHeader } from '../components/PageHeader';
import { RequestCard } from '../components/RequestCard';
import { ErrorCard } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { TaskCard } from '../components/TaskCard';
import { Questionnaire } from '../components/Questionnaire';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, normalizeKe, phone, when } from '../format';

type Step = 'form' | 'review' | 'result';

/**
 * Asking a customer to pay. Deliberately not the send page with different words: no balance is
 * shown and no password is asked for, because nothing leaves the organisation's accounts. What it
 * does share is the shape the send page proved — type, review, then watch the result arrive — and
 * the same refusal to let one impatient press charge a customer twice.
 */
export function AskToPay() {
  const toast = useToast();
  const [step, setStep] = useState<Step>('form');
  const [to, setTo] = useState('');
  const [cents, setCents] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState<{ at: string } | null>(null);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [request, setRequest] = useState<RequestView | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [round, setRound] = useState(0);

  const normalised = normalizeKe(to);
  const valid = !!normalised && cents !== null && cents % 100 === 0 && reference.trim().length > 0;

  const reload = useCallback((id: string) => api.get<RequestView>(`/api/requests/${id}`).then((r) => {
    setRequest((prev) => {
      if (prev && prev.status !== r.status) {
        if (r.status === 'completed') toast.success(copy.askToPay.result.completed);
        else if (r.status === 'failed') toast.error(copy.askToPay.result.failed);
        else if (r.status === 'unknown') toast.info(copy.askToPay.result.unknown);
      }
      return r;
    });
  }).catch(() => {}), [toast]);

  const requestIdRef = useRef<string | null>(null);
  requestIdRef.current = request?.id ?? null;
  // The customer takes as long as they take. Same pattern the send page uses: re-read on every SSE
  // reconnect rather than trusting one event to arrive, and keep a slow poll while it still says
  // the prompt is out.
  useEvents(useCallback((e) => {
    const p = e.payload as { id?: string };
    const id = requestIdRef.current;
    if (e.type === 'request.updated' && id && p.id === id) void reload(id);
  }, [reload]), step === 'result', useCallback(() => { if (requestIdRef.current) void reload(requestIdRef.current); }, [reload]));
  useEffect(() => {
    if (step !== 'result' || request?.status !== 'sent') return;
    const t = setInterval(() => { if (requestIdRef.current) void reload(requestIdRef.current); }, 15_000);
    return () => clearInterval(t);
  }, [step, request?.status, reload]);

  const submit = async (again = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<RequestView>('/api/collect/stk', {
        phone: to, amountCents: cents, accountReference: reference.trim(),
        description: description.trim() || undefined,
        confirmDuplicate: again || confirmDuplicate || undefined,
      });
      setRequest(r); setDuplicate(null); setConfirmDuplicate(false); setStep('result');
      const resultCopy = copy.askToPay.result as Record<string, string>;
      toast.show(r.status === 'completed' ? 'success' : r.status === 'failed' ? 'error' : 'info', resultCopy[r.status] ?? r.status);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate_recent') setDuplicate({ at: (e.details as { at: string }).at });
      else setErr(e instanceof ApiError ? e : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };

  const reset = () => { setRound((n) => n + 1); setStep('form'); setTo(''); setCents(null); setReference(''); setDescription(''); setRequest(null); setDuplicate(null); setConfirmDuplicate(false); setErr(null); };

  return (
    <>
      <PageHeader title={copy.askToPay.title} safaricom={copy.askToPay.safaricom} />
      {step === 'form' && (
        <Questionnaire key={round} intro={copy.askToPay.intro} doneLabel={copy.askToPay.next} onDone={() => { if (valid) setStep('review'); }} steps={[
          { key: 'phone', question: copy.askToPay.phone, valid: !!normalised, render: () => <PhoneInput label={copy.askToPay.phone} labelHidden value={to} onChange={setTo} autoFocus /> },
          { key: 'amount', question: copy.askToPay.amount, valid: cents !== null && cents % 100 === 0, render: () => <MoneyInput label={copy.askToPay.amount} labelHidden valueCents={cents} onChange={setCents} wholeShillings autoFocus /> },
          { key: 'reference', question: copy.askToPay.reference, hint: copy.askToPay.referenceHint, valid: reference.trim().length > 0, render: () => <TextField label={copy.askToPay.reference} labelHidden value={reference} onChange={(e) => setReference(e.target.value)} maxLength={12} autoFocus /> },
          { key: 'description', question: copy.askToPay.description, hint: copy.askToPay.descriptionHint, optional: true, valid: true, empty: !description, render: () => <TextField label={copy.askToPay.description} labelHidden value={description} onChange={(e) => setDescription(e.target.value)} maxLength={13} autoFocus /> },
        ]} />
      )}

      {step === 'review' && (
        <TaskCard
          footerStart={<Button type="button" variant="secondary" onClick={() => { setStep('form'); setDuplicate(null); setConfirmDuplicate(false); }}>{copy.askToPay.back}</Button>}
          footer={<Button type="button" disabled={busy} onClick={() => void submit()}>{copy.askToPay.ask}</Button>}
        >
          <h2 className="text-xl font-semibold">{copy.askToPay.review.title}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
            <dt className="text-muted">{copy.askToPay.phone}</dt><dd>{phone(normalised)}</dd>
            <dt className="text-muted">{copy.request.amount}</dt><dd>{money(cents)}</dd>
            <dt className="text-muted">{copy.askToPay.reference}</dt><dd>{reference.trim()}</dd>
          </dl>
          <p className="text-sm text-muted">{copy.askToPay.review.note}</p>
          {duplicate && (
            <Flash tone="neutral" role="alert">
              <p>{copy.askToPay.duplicate(when(duplicate.at))}</p>
              <div className="flex gap-2 pt-1">
                <Button type="button" disabled={busy} onClick={() => { setConfirmDuplicate(true); void submit(true); }}>{copy.askToPay.duplicateYes}</Button>
                <Button type="button" variant="secondary" onClick={() => { setDuplicate(null); setConfirmDuplicate(false); toast.info(copy.askToPay.duplicateCancelled); }}>{copy.askToPay.duplicateNo}</Button>
              </div>
            </Flash>
          )}
          <ErrorCard error={err} />
        </TaskCard>
      )}

      {step === 'result' && request && (
        <div className="max-w-xl space-y-4">
          <p role="status" className="text-lg font-semibold">{copy.askToPay.result[request.status as 'sent' | 'completed' | 'failed' | 'unknown'] ?? request.status}</p>
          {request.status === 'sent' && <p className="text-base text-muted">{copy.askToPay.waiting}</p>}
          <RequestCard request={request}>
            {(request.status === 'completed' || request.status === 'failed') && <Button type="button" onClick={reset}>{copy.askToPay.result.askAnother}</Button>}
            {request.status === 'unknown' && <Link className="text-base" to={`/requests/${request.id}`}>{copy.request.markChecked}</Link>}
          </RequestCard>
        </div>
      )}
    </>
  );
}
