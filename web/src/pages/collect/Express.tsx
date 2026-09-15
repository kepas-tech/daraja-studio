import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { RequestView } from '../../api/types';
import { Button } from '../../components/Button';
import { ErrorCard, explainApiError, type Explained } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { MoneyInput } from '../../components/MoneyInput';
import { PageHeader } from '../../components/PageHeader';
import { Questionnaire } from '../../components/Questionnaire';
import { RequestCard } from '../../components/RequestCard';
import { TaskCard } from '../../components/TaskCard';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { money, when } from '../../format';
import { useCollectResult } from './useCollectResult';

type Step = 'form' | 'review' | 'result';

/** The business version of Ask a customer to pay: prompt another business's till, their money arrives here. */
export function Express() {
  const c = copy.express;
  const toast = useToast();
  const [step, setStep] = useState<Step>('form');
  const [till, setTill] = useState(''); const [cents, setCents] = useState<number | null>(null); const [ref, setRef] = useState(''); const [partner, setPartner] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<Error | Explained | null>(null);
  const [duplicate, setDuplicate] = useState<{ at: string } | null>(null);
  const [round, setRound] = useState(0);
  const { request, setRequest } = useCollectResult();
  const valid = /^\d{5,7}$/.test(till.trim()) && cents !== null && cents % 100 === 0 && ref.trim().length > 0;
  const submit = async (again = false) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<RequestView>('/api/collect/express', { till: till.trim(), amountCents: cents, paymentRef: ref.trim(), partnerName: partner.trim() || undefined, confirmDuplicate: again || undefined });
      setRequest(r); setDuplicate(null); setStep('result'); toast.info(c.result.sent);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate_recent') setDuplicate({ at: (e.details as { at: string }).at });
      else setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };
  const reset = () => { setRound((n) => n + 1); setStep('form'); setTill(''); setCents(null); setRef(''); setPartner(''); setRequest(null); setDuplicate(null); setErr(null); };
  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom} />
      {step === 'form' && (
        <Questionnaire key={round} intro={c.intro} doneLabel={copy.askToPay.next} onDone={() => { if (valid) setStep('review'); }} steps={[
          { key: 'till', question: c.till, hint: c.tillHint, valid: /^\d{5,7}$/.test(till.trim()), render: () => <TextField label={c.till} labelHidden inputMode="numeric" value={till} onChange={(e) => setTill(e.target.value)} autoFocus /> },
          { key: 'amount', question: copy.askToPay.amount, valid: cents !== null && cents % 100 === 0, render: () => <MoneyInput label={copy.askToPay.amount} labelHidden valueCents={cents} onChange={setCents} wholeShillings autoFocus /> },
          { key: 'ref', question: c.reference, hint: c.referenceHint, valid: ref.trim().length > 0, render: () => <TextField label={c.reference} labelHidden value={ref} onChange={(e) => setRef(e.target.value)} maxLength={20} autoFocus /> },
          { key: 'partner', question: c.partner, hint: c.partnerHint, optional: true, valid: true, empty: !partner, render: () => <TextField label={c.partner} labelHidden value={partner} onChange={(e) => setPartner(e.target.value)} maxLength={40} autoFocus /> },
        ]} />
      )}
      {step === 'review' && (
        <TaskCard footerStart={<Button type="button" variant="secondary" onClick={() => { setStep('form'); setDuplicate(null); }}>{copy.askToPay.back}</Button>} footer={<Button type="button" disabled={busy} onClick={() => void submit()}>{c.ask}</Button>}>
          <h2 className="text-xl font-semibold">{copy.askToPay.review.title}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
            <dt className="text-muted">{c.till}</dt><dd>{till.trim()}</dd>
            <dt className="text-muted">{copy.request.amount}</dt><dd>{money(cents)}</dd>
            <dt className="text-muted">{c.reference}</dt><dd>{ref.trim()}</dd>
          </dl>
          <p className="text-sm text-muted">{c.reviewNote}</p>
          {duplicate && (
            <Flash tone="neutral" role="alert">
              <p>{copy.askToPay.duplicate(when(duplicate.at))}</p>
              <div className="flex gap-2 pt-1"><Button type="button" disabled={busy} onClick={() => void submit(true)}>{copy.askToPay.duplicateYes}</Button><Button type="button" variant="secondary" onClick={() => setDuplicate(null)}>{copy.askToPay.duplicateNo}</Button></div>
            </Flash>
          )}
          <ErrorCard error={err} />
        </TaskCard>
      )}
      {step === 'result' && request && (
        <div className="max-w-xl space-y-4">
          <p role="status" className="text-lg font-semibold">{c.result[request.status as 'sent' | 'completed' | 'failed' | 'unknown'] ?? request.status}</p>
          {request.status === 'sent' && <p className="text-base text-muted">{c.waiting}</p>}
          <RequestCard request={request}>{(request.status === 'completed' || request.status === 'failed') && <Button type="button" onClick={reset}>{c.another}</Button>}</RequestCard>
        </div>
      )}
    </>
  );
}
