import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import type { RequestView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { RequestCard } from '../components/RequestCard';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { TaskCard } from '../components/TaskCard';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, when } from '../format';

type Step = 'form' | 'review' | 'result';

/** What GET /api/send/reversal/:receipt answers: the settled payment that would be taken back. */
interface SettledPayment { requestId: string; receipt: string; amountCents: number; at: string; type: string }

/**
 * M3: reverse a payment. Three steps, and the middle one exists because a reversal cannot be
 * undone: the operator sees the payment that actually settled, the amount, and a plain warning
 * before a password is asked for.
 *
 * The page never guesses whether Safaricom can still take the money back. It says up front that the
 * customer must still have the money, and when Safaricom refuses because they have spent it, the
 * result card carries Safaricom's own words and what they mean.
 */
export function Reverse() {
  const toast = useToast();
  const [step, setStep] = useState<Step>('form');
  const [receipt, setReceipt] = useState('');
  const [found, setFound] = useState<SettledPayment | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<Error | Explained | null>(null);
  const [request, setRequest] = useState<RequestView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const resultCopy = copy.reverse.result as Record<string, string>;

  const clean = receipt.trim().toUpperCase();
  const valid = /^[A-Z0-9]{10}$/.test(clean);

  // The pre-check: a receipt that settled nowhere is refused here, before any password and before
  // Safaricom is asked anything.
  const find = async () => {
    setErr(null); setFound(null); setPending(true);
    try { setFound(await api.get<SettledPayment>('/api/send/reversal/' + clean)); setStep('review'); }
    catch (e) { setErr(explainApiError(e)); }
    finally { setPending(false); }
  };

  const reload = useCallback((id: string) => api.get<RequestView>('/api/requests/' + id).then((r) => {
    setRequest((prev) => {
      if (prev && prev.status !== r.status) {
        if (r.status === 'completed') toast.success(resultCopy.completed);
        else if (r.status === 'failed') toast.error(resultCopy.failed);
        else if (r.status === 'unknown') toast.info(resultCopy.unknown);
      }
      return r;
    });
  }).catch(() => {}), [toast, resultCopy]);
  const requestIdRef = useRef<string | null>(null);
  requestIdRef.current = request?.id ?? null;
  // W2, the same pattern the send page uses: re-fetch on every SSE event for this row, again on
  // every stream (re)connect, and poll every 15 s only while Safaricom still has it.
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

  const submit = async (password: string) => {
    setBusy(true); setDialogError(null); setErr(null);
    try {
      const r = await api.post<RequestView>('/api/send/reversal', { receipt: clean, password });
      setRequest(r); setConfirm(false); setStep('result');
      toast.show(r.status === 'completed' ? 'success' : r.status === 'failed' ? 'error' : 'info', resultCopy[r.status] ?? r.status);
    } catch (e) {
      // Refused before Safaricom was called (already reversed, no permission, not ready): close the
      // dialog and say so on the form. A refusal by Safaricom itself comes back as a recorded row.
      setConfirm(false);
      setErr(explainApiError(e));
      setStep('form');
    } finally { setBusy(false); }
  };

  const reset = () => { setStep('form'); setReceipt(''); setFound(null); setRequest(null); setErr(null); };

  return (
    <>
      <PageHeader title={copy.reverse.title} safaricom={copy.reverse.safaricom} />
      {step === 'form' && (
        <form onSubmit={(e) => { e.preventDefault(); if (valid && !pending) void find(); }}>
          <TaskCard footer={<Button type="submit" disabled={!valid || pending}>{pending ? copy.reverse.finding : copy.reverse.find}</Button>}>
            <TextField label={copy.reverse.receipt} value={receipt} onChange={(e) => setReceipt(e.target.value)} autoFocus autoComplete="off" hint={copy.reverse.hint} />
            <Flash tone="neutral">{copy.reverse.spent}</Flash>
            <ErrorCard error={err} />
          </TaskCard>
        </form>
      )}

      {step === 'review' && found && (
        <>
          <TaskCard
            footerStart={<Button type="button" variant="secondary" onClick={() => { setStep('form'); setErr(null); }}>{copy.reverse.back}</Button>}
            footer={<Button type="button" variant="danger" disabled={busy} onClick={() => { setDialogError(null); setConfirm(true); }}>{copy.reverse.button}</Button>}
          >
            <h2 className="text-xl font-semibold">{copy.reverse.found}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
              <dt className="text-muted">{copy.request.receipt}</dt><dd><code>{found.receipt}</code></dd>
              <dt className="text-muted">{copy.request.amount}</dt><dd>{money(found.amountCents)}</dd>
              <dt className="text-muted">{copy.reverse.settledOn}</dt><dd>{when(found.at)}</dd>
            </dl>
            <p className="text-base">{copy.reverse.willTakeBack}</p>
            <Flash tone="danger" role="alert">{copy.reverse.irreversible}</Flash>
            <ErrorCard error={err} />
          </TaskCard>
          <PasswordConfirmDialog open={confirm} title={copy.reverse.confirmTitle(money(found.amountCents), found.receipt)} busy={busy} error={dialogError} onConfirm={(pw) => void submit(pw)} onCancel={() => setConfirm(false)} />
        </>
      )}

      {step === 'result' && request && (
        <div className="max-w-xl space-y-4">
          <p role="status" className="text-lg font-semibold">{resultCopy[request.status] ?? request.status}</p>
          <RequestCard request={request}>
            {request.status === 'sent' && <Link className="text-base" to={'/requests/' + request.id}>{copy.request.checkNow}</Link>}
            <Button type="button" onClick={reset}>{copy.reverse.result.another}</Button>
          </RequestCard>
          <p className="text-sm text-muted"><Link to="/history">{copy.reverse.history}</Link></p>
        </div>
      )}
    </>
  );
}
