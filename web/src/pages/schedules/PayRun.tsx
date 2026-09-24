import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../../api/client';
import type { PayRunView } from '../../api/types';
import { useEvents } from '../../api/events';
import { Button } from '../../components/Button';
import { Card, cardRow } from '../../components/Card';
import { ErrorCard } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { PageHeader } from '../../components/PageHeader';
import { PasswordConfirmDialog } from '../../components/PasswordConfirmDialog';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { useStepUp } from '../settings/useStepUp';
import { copy } from '../../copy/en';
import { day, money } from '../../format';
import { RUN_TONE } from './ScheduleDetail';

const LINE_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = { waiting: 'muted', sent: 'warn', paid: 'ok', failed: 'bad', unknown: 'warn' };

/** One pay run: every line with its receipt or its reason, and Try again for a run the float held back. */
export function PayRun() {
  const c = copy.schedules.run;
  const { runId } = useParams();
  const toast = useToast();
  const stepUp = useStepUp();
  const [run, setRun] = useState<PayRunView | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const load = useCallback(() => {
    api.get<PayRunView>(`/api/schedules/runs/${runId}`).then(setRun).catch((e) => setErr(e instanceof Error ? e : new Error(copy.error.generic)));
  }, [runId]);
  useEffect(load, [load]);
  useEvents(useCallback((e) => { if (e.type === 'request.updated') load(); }, [load]), true, load);
  const retry = () => stepUp.ask(c.retryTitle, async (confirm) => {
    setRun(await api.post<PayRunView>(`/api/schedules/runs/${runId}/retry`, confirm)); toast.success(c.retried);
  });

  if (!run) return (<><PageHeader title={copy.schedules.title} /><ErrorCard error={err} />{!err && <p className="text-muted">{copy.app.loading}</p>}</>);
  return (
    <>
      <PageHeader title={c.title(run.scheduleName, day(run.payOn))} safaricom={copy.schedules.safaricom} />
      <div className="max-w-2xl space-y-4">
        <p className="flex flex-wrap items-center gap-3">
          <StatusPill kind={RUN_TONE[run.state] ?? 'muted'}>{c.state[run.state] ?? run.state}</StatusPill>
          <span className="text-base">{money(run.totalCents)}</span>
          <Link to={`/schedules/${run.scheduleId}`} className="text-sm">{run.scheduleName}</Link>
        </p>
        {run.reason && <Flash tone={run.state === 'refused' || run.state === 'missed' ? 'danger' : 'neutral'} role="alert">{run.reason}</Flash>}
        {run.state === 'refused' && <Button type="button" onClick={retry}>{c.retry}</Button>}
        <Card bodyClassName="p-0">
          <ul>
            {run.lines.map((l) => (
              <li key={l.id} data-testid="run-line" className={`${cardRow} flex flex-wrap items-center justify-between gap-3 text-base`}>
                <span className="min-w-0">{l.name}
                  <span className="block text-sm text-muted">{l.destination}{l.accountReference ? ' · ' + l.accountReference : ''}{l.receipt ? ' · ' + l.receipt : ''}</span>
                  {l.failure && <span className="block text-sm text-danger">{l.failure}</span>}
                  {l.requestId && <Link className="block text-sm" to={`/requests/${l.requestId}`}>{c.openPayment}</Link>}
                </span>
                <span>{money(l.amountCents)}</span>
                <StatusPill kind={LINE_TONE[l.state] ?? 'muted'}>{c.lineState[l.state] ?? l.state}</StatusPill>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
