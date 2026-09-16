import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { ErrorCard, type Explained } from '../components/ErrorCard';
import { Card } from '../components/Card';
import { Flash } from '../components/Flash';
import { Questionnaire } from '../components/Questionnaire';
import { CustomerPicker } from '../components/CustomerPicker';
import { Segmented } from '../components/Segmented';
import { MoneyInput } from '../components/MoneyInput';
import { PageHeader } from '../components/PageHeader';
import { TextField } from '../components/TextField';
import { copy } from '../copy/en';
import { money } from '../format';

interface Details { merchantName: string; shortcode: string; environment: 'sandbox' | 'production' }
interface Generated extends Details { imageUrl: string; accountReference: string; amountCents: number; trxCode: 'PB' | 'BG' }
const text = copy.qr;
function errorLines(e: unknown): Explained {
  if (e instanceof ApiError && e.details && typeof e.details === 'object') {
    const d = e.details as Partial<Explained>;
    if (typeof d.safaricomSaid === 'string' && typeof d.meaning === 'string' && typeof d.whatToDo === 'string') return d as Explained;
  }
  return { safaricomSaid: text.noResponse, meaning: e instanceof Error ? e.message : copy.error.generic, whatToDo: text.retry };
}

export function Qr() {
  const session = useSession();
  const allowed = !!session.person?.is_owner || session.permissions.includes('qr.generate');
  const [details, setDetails] = useState<Details | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [reference, setReference] = useState('');
  const [trxCode, setTrxCode] = useState<'PB' | 'BG'>('PB');
  const [amount, setAmount] = useState<number | null>(null);
  const [customerAmount, setCustomerAmount] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [result, setResult] = useState<Generated | null>(null);
  const [error, setError] = useState<Explained | null>(null);
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    setError(null);
    api.get<Details>('/api/qr').then((v) => { if (live) setDetails(v); }).catch((e: unknown) => { if (live) setError(errorLines(e)); });
    return () => { live = false; };
  }, [allowed, attempt]);
  const valid = !!details && reference.trim().length > 0 && reference.trim().length <= 32
    && (customerAmount || (amount !== null && Number.isSafeInteger(amount) && amount > 0));
  function changed() { setResult(null); setError(null); }
  async function generate() {
    if (!valid || sending.current) return;
    sending.current = true; setBusy(true); setResult(null); setError(null);
    try {
      const answer = await api.post<Generated>('/api/qr', { accountReference: reference.trim(), trxCode, amountCents: customerAmount ? 0 : amount });
      if (typeof answer?.imageUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(answer.imageUrl)) throw new Error(text.badResponse);
      setResult(answer);
    } catch (e) { setError(errorLines(e)); }
    finally { sending.current = false; setBusy(false); }
  }
  const env = (result ?? details)?.environment;
  return <>
    <PageHeader title={text.title} safaricom={text.safaricom} />
    {!allowed ? <Flash tone="danger" role="alert" className="max-w-xl">{text.noPermission}</Flash> : <div className="space-y-4">
      {!details && !error && <p role="status" className="text-muted">{copy.app.loading}</p>}
      {!details && error && <div className="max-w-xl space-y-3"><ErrorCard error={error} /><Button onClick={() => setAttempt((v) => v + 1)}>{copy.app.retry}</Button></div>}
      {details && (
        <Questionnaire doneLabel={busy ? text.generating : text.generate} busy={busy} intro={<>{text.payee}: <strong className="text-ink">{details.merchantName}</strong> · {text.shortcode}: {details.shortcode}</>} onDone={() => void generate()} steps={[
          { key: 'type', question: text.type, valid: true, render: () => <Segmented name="trxCode" label={text.type} value={trxCode} options={[{ value: 'PB', label: text.paybill }, { value: 'BG', label: text.till }]} onChange={(v) => { changed(); setTrxCode(v); }} /> },
          { key: 'reference', question: text.reference, hint: text.referenceHint, valid: reference.trim().length > 0 && reference.trim().length <= 32, render: () => (
            <div className="space-y-3">
              <CustomerPicker label={text.pickCustomer} onPick={(x) => { changed(); setReference(x.accountNumber); }} />
              <TextField label={text.reference} labelHidden value={reference} maxLength={32} onChange={(e) => { changed(); setReference(e.target.value); }} autoFocus />
            </div>
          ) },
          { key: 'who', question: text.who, valid: true, render: () => <Segmented name="who" label={text.who} value={customerAmount ? 'customer' : 'fixed'} options={[{ value: 'fixed', label: text.fixed }, { value: 'customer', label: text.customerAmount }]} onChange={(v) => { changed(); setCustomerAmount(v === 'customer'); }} /> },
          ...(customerAmount ? [] : [{ key: 'amount', question: text.amount, valid: amount !== null && Number.isSafeInteger(amount) && amount > 0, render: () => <MoneyInput label={text.amount} labelHidden valueCents={amount} onChange={(v) => { changed(); setAmount(v); }} autoFocus /> }]),
        ]} />
      )}
      {error && details && <div className="max-w-xl"><ErrorCard error={error} /></div>}
      {env && <Flash tone={env === 'sandbox' ? 'neutral' : 'success'} className="max-w-xl"><p>{env === 'sandbox' ? text.sandbox : text.production}</p><p className="text-sm text-muted">{text.unpaid}</p></Flash>}
      {result && <Card className="max-w-xl" title={result.merchantName} aria-label={text.ready} bodyClassName="space-y-3 p-4">
        <p className="text-sm text-muted">{text.shortcode}: {result.shortcode} · {result.trxCode === 'PB' ? text.paybill : text.till} · {result.amountCents === 0 ? text.customerAmount : money(result.amountCents)} · {result.accountReference}</p>
        <img className="h-auto w-full max-w-[400px] rounded-md bg-surface" src={result.imageUrl} alt={text.imageAlt} width="400" height="400"
          onError={() => { setResult(null); setError(errorLines(new Error(text.badResponse))); }} />
        <p>{text.scan}</p>
        <a className="inline-flex min-h-11 items-center rounded-md border border-line bg-page px-4 font-semibold text-ink hover:bg-line/60 hover:no-underline" href={result.imageUrl} download="mpesa-qr.png">{text.download}</a>
      </Card>}
    </div>}
  </>;
}
