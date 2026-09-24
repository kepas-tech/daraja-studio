import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import type { Confirm, PayRunSummary, ScheduleView } from '../../api/types';
import { useEvents } from '../../api/events';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { Card, cardRow } from '../../components/Card';
import { ErrorCard } from '../../components/ErrorCard';
import { PageHeader } from '../../components/PageHeader';
import { PasswordConfirmDialog } from '../../components/PasswordConfirmDialog';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { useStepUp } from '../settings/useStepUp';
import { copy } from '../../copy/en';
import { day, money, when } from '../../format';
import { STATE_TONE, linkButton } from './ScheduleList';

export const RUN_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = { prepared: 'muted', sending: 'warn', done: 'ok', partly_failed: 'bad', failed: 'bad', refused: 'bad', missed: 'bad' };

/** One schedule: who it pays, when, who agreed to it, what it has paid, and the three actions. */
export function ScheduleDetail() {
  const c = copy.schedules;
  const { id } = useParams();
  const toast = useToast();
  const stepUp = useStepUp();
  const { pinSet } = useSession();
  const [s, setS] = useState<ScheduleView | null>(null);
  const [runs, setRuns] = useState<PayRunSummary[]>([]);
  const [err, setErr] = useState<Error | null>(null);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopErr, setStopErr] = useState<Error | null>(null);

  const load = useCallback(() => {
    api.get<ScheduleView>(`/api/schedules/${id}`).then(setS).catch((e) => setErr(e instanceof Error ? e : new Error(copy.error.generic)));
    api.get<{ items: PayRunSummary[] }>(`/api/schedules/${id}/runs`).then((r) => setRuns(r.items)).catch(() => setRuns([]));
  }, [id]);
  useEffect(load, [load]);
  useEvents(useCallback((e) => { if (e.type === 'request.updated') load(); }, [load]), true, load);

  const pause = async () => {
    try { setS(await api.post<ScheduleView>(`/api/schedules/${id}/pause`, {})); toast.info(c.home.paused1); }
    catch (e) { setErr(e instanceof ApiError ? e : new Error(copy.error.generic)); }
  };
  const resume = () => stepUp.ask(c.detail.resumeTitle(s?.name ?? ''), async (confirm) => {
    setS(await api.post<ScheduleView>(`/api/schedules/${id}/resume`, confirm)); toast.success(c.detail.resumed);
  });
  const stop = async (confirm: Confirm) => {
    setBusy(true); setStopErr(null);
    try { setS(await api.post<ScheduleView>(`/api/schedules/${id}/stop`, { name: s?.name, ...confirm })); setStopping(false); toast.info(c.detail.stopped); }
    catch (e) { setStopErr(e instanceof ApiError ? e : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };

  if (!s) return (<><PageHeader title={c.title} /><ErrorCard error={err} />{!err && <p className="text-muted">{copy.app.loading}</p>}</>);
  const open = s.state === 'active' || s.state === 'paused';
  return (
    <>
      <PageHeader title={s.name} safaricom={c.safaricom} />
      <div className="max-w-2xl space-y-4">
        <ErrorCard error={err} />
        <p className="flex flex-wrap items-center gap-3">
          <StatusPill kind={STATE_TONE[s.state] ?? 'muted'}>{c.state[s.state] ?? s.state}</StatusPill>
          <span className="text-base">{s.words}</span>
        </p>
        {s.consentedBy && <p className="text-sm text-muted">{c.detail.consented(s.consentedBy, when(s.consentedAt))}</p>}
        {open && (
          <div className="flex flex-wrap gap-2">
            <Link className={linkButton} to={`/schedules/${s.id}/edit`}>{c.detail.edit}</Link>
            {s.state === 'active' && <Button type="button" variant="secondary" onClick={() => void pause()}>{c.detail.pause}</Button>}
            {s.state === 'paused' && <Button type="button" onClick={resume}>{c.detail.resume}</Button>}
            <Button type="button" variant="danger" onClick={() => { setStopErr(null); setStopping(true); }}>{c.detail.stop}</Button>
          </div>
        )}
        <Card title={c.detail.lines} bodyClassName="p-0">
          <ul>
            {s.lines.map((l) => (
              <li key={l.id} className={`${cardRow} flex flex-wrap items-center justify-between gap-3 text-base`}>
                <span className="min-w-0">{l.name}<span className="block text-sm text-muted">{l.destination}{l.accountReference ? ' · ' + l.accountReference : ''}{l.note ? ' · ' + l.note : ''}</span>
                  {l.gone && <span className="block text-sm text-danger">{c.detail.gone}</span>}</span>
                <span>{money(l.amountCents)}</span>
              </li>
            ))}
            <li className={`${cardRow} flex justify-between font-semibold`}><span>{c.detail.totalLabel}</span><span>{money(s.totalCents)}</span></li>
          </ul>
        </Card>
        {s.upcoming.length > 0 && (
          <Card title={c.detail.next}>
            <ul className="list-disc pl-6">{s.upcoming.map((d) => <li key={d}>{day(d)}</li>)}</ul>
          </Card>
        )}
        <Card title={c.detail.runs} bodyClassName="p-0">
          {runs.length === 0 ? <p className="p-4 text-muted">{c.detail.noRuns}</p> : (
            <ul>
              {runs.map((r) => (
                <li key={r.id} className={`${cardRow} flex flex-wrap items-center justify-between gap-3 text-base`}>
                  <Link to={`/schedules/runs/${r.id}`}>{day(r.payOn)}</Link>
                  <span>{money(r.totalCents)}</span>
                  <StatusPill kind={RUN_TONE[r.state] ?? 'muted'}>{c.run.state[r.state] ?? r.state}</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <PasswordConfirmDialog {...stepUp.dialogProps} />
      <PasswordConfirmDialog open={stopping} title={c.detail.stopTitle} danger busy={busy} error={stopErr} pin={pinSet}
        challenge={{ label: c.detail.stopBody, expected: s.name }} onConfirm={(confirm) => void stop(confirm)} onCancel={() => setStopping(false)} />
    </>
  );
}
