import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import type { Confirm, RequestView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
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
      </div>
      <PasswordConfirmDialog open={confirm} title={copy.request.markCheckedConfirm} busy={busy} error={dialogError} onConfirm={(confirm) => void markChecked(confirm)} onCancel={() => setConfirm(false)} />
    </>
  );
}
