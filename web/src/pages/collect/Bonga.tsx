import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../../api/client';
import type { MoneyInView, RequestView } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { PageHeader } from '../../components/PageHeader';
import { PhoneInput } from '../../components/PhoneInput';
import { Questionnaire } from '../../components/Questionnaire';
import { RequestCard } from '../../components/RequestCard';
import { TaskCard } from '../../components/TaskCard';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { money, normalizeKe, phone } from '../../format';
import { useCollectResult } from './useCollectResult';

type Step = 'form' | 'review' | 'result';

/** Points to shillings (read only), then a redemption the customer confirms with their PIN. */
export function Bonga() {
  const c = copy.bonga;
  const toast = useToast();
  const [moneyIn, setMoneyIn] = useState<MoneyInView | null>(null);
  const [points, setPoints] = useState('');
  const [worth, setWorth] = useState<{ points: number; amountCents: number; rate: number } | null>(null);
  const [customer, setCustomer] = useState(''); const [account, setAccount] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<Error | Explained | null>(null);
  const [round, setRound] = useState(0);
  const { request, setRequest } = useCollectResult();
  useEffect(() => { api.get<MoneyInView>('/api/money-in/status').then(setMoneyIn).catch(() => {}); }, []);
  const n = Number(points);
  useEffect(() => {
    if (!Number.isInteger(n) || n <= 0) { setWorth(null); return; }
    const t = setTimeout(() => { api.post<{ points: number; amountCents: number; rate: number }>('/api/collect/bonga/calculate', { points: n }).then(setWorth).catch(() => setWorth(null)); }, 300);
    return () => clearTimeout(t);
  }, [n]);
  const valid = !!worth && worth.points === n && !!normalizeKe(customer) && account.trim().length > 0;
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.post<RequestView>('/api/collect/bonga/redeem', { phone: customer, points: n, accountReference: account.trim() }); setRequest(r); setStep('result'); toast.info(c.result.sent); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  const reset = () => { setRound((k) => k + 1); setStep('form'); setPoints(''); setWorth(null); setCustomer(''); setAccount(''); setRequest(null); setErr(null); };
  const off = moneyIn !== null && !moneyIn.c2bRegisteredAt;
  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom} />
      {off && <Flash tone="neutral" className="mb-4"><p>{c.needsMoneyIn} <Link to="/money-in">{copy.moneyIn.title}</Link></p></Flash>}
      {step === 'form' && (
        <Questionnaire key={round} intro={c.intro} doneLabel={copy.askToPay.next} onDone={() => { if (valid) setStep('review'); }} steps={[
          { key: 'points', question: c.points, hint: worth && worth.points === n ? c.worth(money(worth.amountCents), worth.rate) : c.pointsHint, valid: !!worth && worth.points === n, render: () => <TextField label={c.points} labelHidden inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/[^0-9]/g, ''))} autoFocus /> },
          { key: 'phone', question: c.phone, valid: !!normalizeKe(customer), render: () => <PhoneInput label={c.phone} labelHidden value={customer} onChange={setCustomer} autoFocus /> },
          { key: 'account', question: c.account, hint: c.accountHint, valid: account.trim().length > 0, render: () => <TextField label={c.account} labelHidden value={account} onChange={(e) => setAccount(e.target.value)} maxLength={20} autoFocus /> },
        ]} />
      )}
      {step === 'review' && worth && (
        <TaskCard footerStart={<Button type="button" variant="secondary" onClick={() => setStep('form')}>{copy.askToPay.back}</Button>} footer={<Button type="button" disabled={busy || off} onClick={() => void submit()}>{c.redeem}</Button>}>
          <h2 className="text-xl font-semibold">{copy.askToPay.review.title}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
            <dt className="text-muted">{c.points}</dt><dd>{worth.points.toLocaleString('en-KE')}</dd>
            <dt className="text-muted">{copy.request.amount}</dt><dd>{money(worth.amountCents)}</dd>
            <dt className="text-muted">{c.phone}</dt><dd>{phone(normalizeKe(customer))}</dd>
            <dt className="text-muted">{c.account}</dt><dd>{account.trim()}</dd>
          </dl>
          <p className="text-sm text-muted">{c.reviewNote}</p>
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
      {step === 'form' && <Card className="mt-6 max-w-xl" bodyClassName="p-4"><p className="text-sm text-muted">{c.how}</p></Card>}
    </>
  );
}
