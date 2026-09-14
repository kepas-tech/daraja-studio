import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import { useEvents } from '../../api/events';
import type { BalanceView, RequestView } from '../../api/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { MoneyInput } from '../../components/MoneyInput';
import { PhoneInput } from '../../components/PhoneInput';
import { PasswordConfirmDialog } from '../../components/PasswordConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { RequestCard } from '../../components/RequestCard';
import { ErrorCard } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { Segmented } from '../../components/Segmented';
import { TaskCard } from '../../components/TaskCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { money, normalizeKe, phone, when } from '../../format';

type Step = 'form' | 'review' | 'result';
type CommandId = 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
const STALE_MS = 24 * 3600 * 1000;

export function SendPhone() {
  const toast = useToast();
  const [step, setStep] = useState<Step>('form');
  const [to, setTo] = useState(''); const [cents, setCents] = useState<number | null>(null); const [kind, setKind] = useState<CommandId>('BusinessPayment'); const [remarks, setRemarks] = useState('');
  const [balance, setBalance] = useState<BalanceView | null | undefined>(undefined);
  const [cap, setCap] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [dialogError, setDialogError] = useState<Error | null>(null);
  const [duplicate, setDuplicate] = useState<{ at: string } | null>(null); const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [againUnavailable, setAgainUnavailable] = useState(false);
  const [request, setRequest] = useState<RequestView | null>(null);
  const [err, setErr] = useState<Error | null>(null);

  const normalised = normalizeKe(to);
  const valid = !!normalised && cents !== null && cents % 100 === 0;

  useEffect(() => { if (step === 'review') api.get<BalanceView | null>('/api/balances/latest').then(setBalance).catch(() => setBalance(null)); }, [step]);
  // W5 (spec §10): the cap is enforced server-side (service.ts) regardless — this is only so the
  // operator sees it before typing their password rather than after a 409 in the dialog.
  useEffect(() => { if (step === 'review') api.get<{ sendCapCents: number | null }>('/healthz').then((h) => setCap(h.sendCapCents)).catch(() => {}); }, [step]);

  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    const again = search.get('again');
    if (!again) return;
    setAgainUnavailable(false);
    api.get<RequestView>(`/api/requests/${again}`).then((prev) => {
      setTo(prev.recipient.value ?? ''); setCents(prev.amountCents); setKind((prev.subtype as CommandId) ?? 'BusinessPayment'); setRemarks(prev.remarks ?? ''); setConfirmDuplicate(true); setStep('review');
    }).catch(() => { setAgainUnavailable(true); }).finally(() => { setSearch((p) => { p.delete('again'); return p; }, { replace: true }); });
  }, [search, setSearch]);

  const reload = useCallback((id: string) => api.get<RequestView>(`/api/requests/${id}`).then((r) => {
    setRequest((prev) => {
      if (prev && prev.status !== r.status) {
        if (r.status === 'completed') toast.success(copy.send.phone.result.completed);
        else if (r.status === 'failed') toast.error(copy.send.phone.result.failed);
        else if (r.status === 'unknown') toast.info(copy.send.phone.result.unknown);
      }
      return r;
    });
  }).catch(() => {}), [toast]);
  const requestIdRef = useRef<string | null>(null);
  requestIdRef.current = request?.id ?? null;
  // W2: re-fetch on every SSE (re)connect, not just on an event that might never arrive, and keep
  // polling every 15 s while the card still says "Sent" — never a busy loop, cleared on unmount
  // or once the result is in.
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
      const r = await api.post<RequestView>('/api/send/phone', { phone: to, amountCents: cents, commandId: kind, remarks: remarks || undefined, confirmDuplicate: confirmDuplicate || undefined, password });
      setRequest(r); setConfirm(false); setDuplicate(null); setConfirmDuplicate(false); setStep('result');
      const resultCopy = copy.send.phone.result as Record<string, string>;
      toast.show(r.status === 'completed' ? 'success' : r.status === 'failed' ? 'error' : 'info', resultCopy[r.status] ?? r.status);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate_recent') { setConfirm(false); setDuplicate({ at: (e.details as { at: string }).at }); }
      else setDialogError(e instanceof ApiError ? e : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };

  const reset = () => { setStep('form'); setTo(''); setCents(null); setRemarks(''); setRequest(null); setDuplicate(null); setConfirmDuplicate(false); setErr(null); };
  const again = () => { if (request) { setTo(request.recipient.value ?? ''); setCents(request.amountCents); setKind((request.subtype as CommandId) ?? 'BusinessPayment'); setRemarks(request.remarks ?? ''); setConfirmDuplicate(true); setRequest(null); setStep('review'); } };

  const utilityAfter = balance?.utilityCents != null && cents !== null ? balance.utilityCents - cents : null;
  const short = utilityAfter !== null && utilityAfter < 0;
  const overCap = cap !== null && cents !== null && cents > cap;
  const stale = balance?.queriedAt ? Date.now() - new Date(balance.queriedAt).getTime() > STALE_MS : false;

  const kinds = (['BusinessPayment', 'SalaryPayment', 'PromotionPayment'] as CommandId[]).map((k) => ({ value: k, label: copy.send.phone.kinds[k] }));
  return (
    <>
      <PageHeader title={copy.send.phone.title} safaricom={copy.send.phone.safaricom} />
      {step === 'form' && (
        <form onSubmit={(e) => { e.preventDefault(); if (valid) setStep('review'); }}>
          {againUnavailable && <Flash tone="neutral" role="alert" className="mb-4 max-w-xl">{copy.send.phone.againUnavailable}</Flash>}
          <TaskCard intro={copy.send.phoneIntro} footer={<Button type="submit" disabled={!valid}>{copy.send.phone.next}</Button>}>
            <PhoneInput label={copy.send.phone.recipient} value={to} onChange={setTo} autoFocus />
            <MoneyInput label={copy.send.phone.amount} valueCents={cents} onChange={setCents} wholeShillings />
            <div>
              <span className="mb-1 block text-base font-semibold">{copy.send.phone.kind}</span>
              <Segmented name="commandId" label={copy.send.phone.kind} value={kind} options={kinds} onChange={setKind} />
            </div>
            <TextField label={copy.send.phone.remarks} value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={100} />
          </TaskCard>
        </form>
      )}

      {step === 'review' && (
        <div className="max-w-xl space-y-4">
          <TaskCard
            footerStart={<Button type="button" variant="secondary" onClick={() => { setStep('form'); setConfirmDuplicate(false); setDuplicate(null); }}>{copy.send.phone.back}</Button>}
            footer={<Button type="button" disabled={short || overCap || busy} onClick={() => { setDialogError(null); setConfirm(true); }}>{copy.send.phone.send}</Button>}
          >
            <h2 className="text-xl font-semibold">{copy.send.phone.review.title}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
              <dt className="text-muted">{copy.request.to}</dt><dd>{phone(normalised)}<span className="block text-sm text-muted">{copy.send.phone.review.nameNote}</span></dd>
              <dt className="text-muted">{copy.request.amount}</dt><dd>{money(cents)}<span className="block text-sm text-muted">{copy.send.phone.review.feeNote}</span></dd>
              <dt className="text-muted">{copy.send.phone.kind}</dt><dd>{copy.send.phone.kinds[kind]}</dd>
              <dt className="text-muted">{copy.send.phone.review.balanceNow}</dt>
              <dd>{balance === undefined ? copy.app.loading : balance === null || balance.utilityCents === null ? copy.send.phone.review.balanceMissing : money(balance.utilityCents)}
                {stale && balance?.queriedAt && <span className="block text-sm text-muted">{copy.send.phone.review.balanceStale(when(balance.queriedAt))}</span>}</dd>
              {utilityAfter !== null && <><dt className="text-muted">{copy.send.phone.review.balanceAfter}</dt><dd>{money(utilityAfter)}</dd></>}
            </dl>
            <p className="text-sm text-muted">{copy.send.phone.review.debits}</p>
            {cap !== null && <p className="text-sm text-muted">{copy.send.phone.review.cap(money(cap))}</p>}
            {short && <Flash tone="danger" role="alert">{copy.send.phone.review.short}</Flash>}
            {duplicate && (
              <Flash tone="neutral" role="alert">
                <p>{copy.send.phone.duplicate(when(duplicate.at))}</p>
                <div className="flex gap-2 pt-1">
                  <Button type="button" onClick={() => { setConfirmDuplicate(true); setDuplicate(null); setConfirm(true); }}>{copy.send.phone.duplicateYes}</Button>
                  <Button type="button" variant="secondary" onClick={() => { setDuplicate(null); setConfirmDuplicate(false); toast.info(copy.send.phone.duplicateCancelled); }}>{copy.send.phone.duplicateNo}</Button>
                </div>
              </Flash>
            )}
            <ErrorCard error={err} />
          </TaskCard>
          <PasswordConfirmDialog open={confirm} title={copy.send.phone.confirmTitle(money(cents), phone(normalised))} busy={busy} error={dialogError} onConfirm={(pw) => void submit(pw)} onCancel={() => setConfirm(false)} />
        </div>
      )}

      {step === 'result' && request && (
        <div className="max-w-xl space-y-4">
          <p role="status" className="text-lg font-semibold">{copy.send.phone.result[request.status as 'sent' | 'completed' | 'failed' | 'unknown'] ?? request.status}</p>
          <RequestCard request={request}>
            {request.status === 'completed' && <Button type="button" onClick={reset}>{copy.send.phone.result.sendAnother}</Button>}
            {request.status === 'failed' && <Button type="button" onClick={again}>{request.retriable ? copy.request.tryAgain : copy.request.sendAgain}</Button>}
            {request.status === 'unknown' && <Link className="text-base" to={`/requests/${request.id}`}>{copy.request.markChecked}</Link>}
          </RequestCard>
        </div>
      )}
    </>
  );
}
