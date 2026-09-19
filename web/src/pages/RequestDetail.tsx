import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import type { CaseView, Confirm, RequestView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { StatusPill } from '../components/StatusPill';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { PageHeader } from '../components/PageHeader';
import { RequestCard } from '../components/RequestCard';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { useToast } from '../components/Toast';
import { Loading } from '../components/Loading';
import { Flash } from '../components/Flash';
import { copy } from '../copy/en';
import { when } from '../format';

export function RequestDetail() {
  const toast = useToast();
  const { id = '' } = useParams();
  const [r, setR] = useState<RequestView | null>(null); const [err, setErr] = useState<Error | Explained | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState(''); const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [dialogError, setDialogError] = useState<Error | Explained | null>(null);
  const load = useCallback(() => api.get<RequestView>(`/api/requests/${id}`).then((v) => { setR(v); setErr(null); }).catch((e) => setErr(explainApiError(e))), [id]);
  useEffect(() => { void load(); }, [load]);
  // W2: re-fetch on every SSE (re)connect, not just on an event that might never arrive, and keep
  // polling every 15 s while still waiting on Safaricom — never a busy loop, cleared on unmount or
  // once the row is no longer sent/pending.
  useEvents(useCallback((e) => { const p = e.payload as { id?: string }; if (e.type === 'request.updated' && p.id === id) { setMsg(null); void load(); } }, [id, load]), true, load);
  useEffect(() => {
    if (!r || (r.status !== 'sent' && r.status !== 'pending')) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [r, load]);
  // Round 3, phase D-5: the case file on this payment. `undefined` until the read lands, `null`
  // when this payment has none; the box is drawn either way, so the empty state is where a case
  // is opened from.
  const { person, permissions, modules } = useSession();
  const casesOn = !modules.off.includes('cases');
  const mayManageCase = casesOn && (!!person?.is_owner || permissions.includes('cases.manage'));
  const [cs, setCs] = useState<CaseView | null | undefined>(undefined);
  const [caseTitle, setCaseTitle] = useState(''); const [caseNote, setCaseNote] = useState(''); const [caseOutcome, setCaseOutcome] = useState('');
  const [caseBusy, setCaseBusy] = useState(false); const [caseErr, setCaseErr] = useState<Error | Explained | null>(null);
  // Only a real case is drawn: a shape this page has not seen leaves the box empty rather than
  // taking the payment's own page down with it.
  const loadCase = useCallback(() => api.get<CaseView | null>(`/api/requests/${id}/case`)
    .then((r) => setCs(r && typeof r.status === 'string' && Array.isArray(r.notes) ? r : null))
    .catch(() => setCs(null)), [id]);
  useEffect(() => { void loadCase(); }, [loadCase]);
  const caseAct = async (send: () => Promise<CaseView>, after?: () => void) => {
    setCaseBusy(true); setCaseErr(null);
    try { setCs(await send()); after?.(); }
    catch (e) { setCaseErr(explainApiError(e)); }
    finally { setCaseBusy(false); }
  };
  const check = async () => { setErr(null); try { await api.post(`/api/requests/${id}/check`); setMsg(copy.request.checkSent); toast.info(copy.request.checkSent); } catch (e) { setErr(explainApiError(e)); } };
  const markChecked = async (confirm: Confirm) => {
    setBusy(true); setDialogError(null);
    try { setR(await api.post<RequestView>(`/api/requests/${id}/checked`, { note, ...confirm })); setConfirm(false); setNote(''); toast.success(copy.request.markedChecked); }
    catch (e) { setDialogError(explainApiError(e)); } finally { setBusy(false); }
  };
  if (err && !r) return <><PageHeader title={copy.request.notFoundTitle} /><ErrorCard error={err} /></>;
  if (!r) return <Loading />;
  const canCheck = (r.status === 'sent' || r.status === 'pending' || r.status === 'unknown') && r.pollAttempts < 5 && r.type === 'b2c';
  const canMarkChecked = r.status === 'unknown' && !r.checked && r.type === 'b2c';
  return (
    <>
      <PageHeader title={copy.request.subtype[r.subtype ?? ''] ?? copy.request.type[r.type] ?? r.type} />
      {msg && <Flash tone="success" role="status" className="mb-4 max-w-lg">{msg}</Flash>}
      <ErrorCard error={err} />
      <div className="max-w-lg space-y-4">
        <RequestCard request={r}>
          {canCheck && <Button type="button" variant="secondary" onClick={() => void check()}>{copy.request.checkNow}</Button>}
          {r.type === 'stk' && r.status === 'completed' && r.receipt && <Link className="inline-flex min-h-11 items-center rounded-md border border-line bg-page px-4 font-semibold text-danger hover:border-danger hover:bg-danger hover:text-surface hover:no-underline" to={`/reverse?receipt=${encodeURIComponent(r.receipt)}`}>{copy.request.reverseThis}</Link>}
          {(r.status === 'completed' || r.status === 'failed') && r.type === 'b2c' && <Link className="inline-flex min-h-11 items-center rounded-md border border-line bg-page px-4 font-semibold text-ink hover:bg-line/60 hover:no-underline" to={`/send/phone?again=${r.id}`}>{r.status === 'failed' && r.retriable ? copy.request.tryAgain : copy.request.sendAgain}</Link>}
        </RequestCard>
        {canMarkChecked && (
          <div className="space-y-3 rounded-md border border-line bg-surface p-5">
            <TextField label={copy.request.markCheckedNote} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            <Button type="button" disabled={!note.trim()} onClick={() => { setDialogError(null); setConfirm(true); }}>{copy.request.markChecked}</Button>
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
          <dt className="text-muted">{copy.request.timeline.created}</dt><dd>{when(r.createdAt)}{r.createdBy && <span className="text-sm text-muted"> · {r.createdBy.displayName}</span>}</dd>
          {r.sentAt && <><dt className="text-muted">{copy.request.timeline.sent}</dt><dd>{when(r.sentAt)}</dd></>}
          {r.resultAt && <><dt className="text-muted">{copy.request.timeline.result}</dt><dd>{when(r.resultAt)}{r.resultSource && <span className="text-sm text-muted"> · {copy.request.source[r.resultSource] ?? r.resultSource}</span>}</dd></>}
          {r.checked && <><dt className="text-muted">{copy.request.timeline.checked}</dt><dd>{when(r.checked.at)}</dd></>}
        </dl>
        {/* Round 3, phase D-5: the case file. Paper, not money: it records what happened and it
            never changes the payment it is about. Step one: it goes with the cases module, which
            declares the case file on a payment as what turning it off hides. */}
        {casesOn && cs !== undefined && (
          <div data-testid="case-file" className="rounded-md border border-line bg-surface p-5">
            <h2 className="text-base font-semibold">{copy.caseFile.title}</h2>
            {cs === null ? (
              <>
                <p className="mt-1 text-sm text-muted">{copy.caseFile.intro}</p>
                {mayManageCase && (
                  <div className="mt-3 space-y-3">
                    <TextField label={copy.caseFile.what} value={caseTitle} onChange={(e) => setCaseTitle(e.target.value)} maxLength={120} />
                    <Button type="button" disabled={!caseTitle.trim() || caseBusy} onClick={() => void caseAct(() => api.post<CaseView>(`/api/requests/${id}/case`, { title: caseTitle.trim() }), () => setCaseTitle(''))}>{caseBusy ? copy.caseFile.opening : copy.caseFile.open}</Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-base font-semibold">
                  {cs.title}
                  <StatusPill kind={cs.status === 'open' ? 'warn' : 'muted'}>{cs.status === 'open' ? copy.caseFile.openStatus : copy.caseFile.closedStatus}</StatusPill>
                </p>
                <p className="text-sm text-muted">{copy.caseFile.opened(when(cs.openedAt), cs.openedBy?.displayName ?? null)}</p>
                <p className="mt-3 text-sm font-semibold">{copy.caseFile.whatWasDone}</p>
                {cs.notes.length === 0 ? <p className="text-sm text-muted">{copy.caseFile.noNotes}</p> : (
                  <ul className="mt-1 space-y-2">
                    {cs.notes.map((n) => (
                      <li key={n.id} className="text-base">
                        {n.note}
                        <span className="block text-sm text-muted">{when(n.at)}{n.by ? ' · ' + n.by.displayName : ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {cs.status === 'open' && mayManageCase && (
                  <div className="mt-4 space-y-3">
                    <TextField label={copy.caseFile.note} value={caseNote} onChange={(e) => setCaseNote(e.target.value)} maxLength={1000} />
                    <Button type="button" variant="secondary" disabled={!caseNote.trim() || caseBusy} onClick={() => void caseAct(() => api.post<CaseView>(`/api/cases/${cs.id}/notes`, { note: caseNote.trim() }), () => setCaseNote(''))}>{copy.caseFile.addNote}</Button>
                    <TextField label={copy.caseFile.outcome} value={caseOutcome} onChange={(e) => setCaseOutcome(e.target.value)} maxLength={500} />
                    <Button type="button" disabled={!caseOutcome.trim() || caseBusy} onClick={() => void caseAct(() => api.post<CaseView>(`/api/cases/${cs.id}/close`, { outcome: caseOutcome.trim() }), () => setCaseOutcome(''))}>{copy.caseFile.close}</Button>
                  </div>
                )}
                {cs.status === 'closed' && (
                  <p className="mt-3 text-base">
                    <span className="font-semibold">{copy.caseFile.outcome}: </span>{cs.outcome}
                    <span className="block text-sm text-muted">{copy.caseFile.closed(when(cs.closedAt), cs.closedBy?.displayName ?? null)} · {copy.caseFile.closedNote}</span>
                  </p>
                )}
              </>
            )}
            {caseErr && <div className="mt-3"><ErrorCard error={caseErr} /></div>}
          </div>
        )}
      </div>
      <PasswordConfirmDialog open={confirm} title={copy.request.markCheckedConfirm} busy={busy} error={dialogError} onConfirm={(confirm) => void markChecked(confirm)} onCancel={() => setConfirm(false)} />
    </>
  );
}
