import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import type { MoneyInView, Page, RequestView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import { useStepUp } from './settings/useStepUp';

/**
 * Money that arrives without a request from us. Two things a business does here: tell Safaricom
 * once where to post payments, and ask for anything a lost confirmation missed. Everything else
 * is reading.
 */
export function MoneyIn() {
  const toast = useToast();
  const { person } = useSession();
  const stepUp = useStepUp();
  const c = copy.moneyIn;
  const [view, setView] = useState<MoneyInView | null>(null);
  const [recent, setRecent] = useState<RequestView[]>([]);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<number | null>(null);
  const justStarted = useRef(false);

  const load = useCallback(async () => {
    const [v, r] = await Promise.all([api.get<MoneyInView>('/api/money-in/status'), api.get<Page<RequestView>>('/api/money-in/recent')]);
    setView(v); setRecent(r.items);
  }, []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'request.updated' || e.type === 'money_in.updated') void load().catch(() => {}); }, [load]));
  // While Safaricom is being told where to post, re-read every few seconds until the answer lands.
  useEffect(() => {
    if (!view?.registering) return;
    const t = setInterval(() => { void load().catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [view?.registering, load]);

  const turnOn = () => stepUp.ask(c.confirmTurnOn, async (password) => {
    const v = await api.post<MoneyInView>('/api/money-in/register', { password });
    justStarted.current = true; setView(v); toast.info(c.registering);
  });
  const registered = !!view?.c2bRegisteredAt;
  useEffect(() => { if (view && !view.registering && registered && !view.lastError && justStarted.current) { justStarted.current = false; toast.success(c.turnedOn); } }, [view, registered, toast, c.turnedOn]);
  const check = async () => {
    setChecking(true); setErr(null); setFound(null);
    try { const r = await api.post<{ found: number; checkedAt: string }>('/api/money-in/check', {}); setFound(r.found); await load(); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setChecking(false); }
  };

  if (!view) return <><PageHeader title={c.title} safaricom={c.safaricom} />{err ? <ErrorCard error={err} /> : <Loading />}</>;
  const on = !!view.c2bRegisteredAt;
  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom} />
      <div className="space-y-6">
        <p className="text-base text-muted">{c.intro}</p>
        <Card title={copy.org.envLine[view.mode]} bodyClassName="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StatusPill kind={on ? 'ok' : 'muted'}>{on ? c.registered(when(view.c2bRegisteredAt)) : c.notRegistered}</StatusPill>
            {person?.is_owner && (
              <Button type="button" variant={on ? 'secondary' : 'primary'} disabled={!view.publicVerified || view.registering} onClick={turnOn}>{view.registering ? c.registeringButton : on ? c.turnOnAgain : c.turnOn}</Button>
            )}
          </div>
          {view.registering && <Flash tone="neutral" role="status">{c.registering}</Flash>}
          {!view.registering && view.lastError && (
            <Flash tone="danger" role="alert">
              <p className="font-semibold text-danger">{c.failed}</p>
              {view.lastError.split('\n').map((line, i) => <p key={i}>{line}</p>)}
            </Flash>
          )}
          {!view.publicVerified && <Flash tone="neutral">{c.needsAddress}</Flash>}
          <p className="text-sm text-muted">{c.validationNote}</p>
        </Card>
        {on && (
          <Card title={c.check} bodyClassName="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" disabled={checking} onClick={() => void check()}>{checking ? c.checking : c.check}</Button>
              <span className="text-sm text-muted">{view.pullCheckedAt ? c.lastChecked(when(view.pullCheckedAt)) : c.checksHourly}</span>
            </div>
            {found !== null && <Flash tone={found > 0 ? 'success' : 'neutral'} role="status">{c.found(found)}</Flash>}
          </Card>
        )}
        <ErrorCard error={err} />
        <Card title={c.recent} actions={<Link className="text-sm" to="/history">{c.allInHistory}</Link>} bodyClassName="p-0">
          {recent.length === 0 ? <p className="p-4 text-base text-muted">{c.empty}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead><tr className="text-left text-sm text-muted">
                  <th className="px-4 py-2 font-medium">{copy.history.columns.when}</th><th className="px-4 py-2 font-medium">{c.from}</th>
                  <th className="px-4 py-2 font-medium">{c.account}</th><th className="px-4 py-2 font-medium">{copy.history.columns.amount}</th><th className="px-4 py-2 font-medium">{copy.history.columns.receipt}</th>
                </tr></thead>
                <tbody>{recent.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="px-4 py-3 whitespace-nowrap">{when(r.sentAt ?? r.createdAt)}</td>
                    <td className="px-4 py-3"><Link to={`/requests/${r.id}`}>{r.recipient.name ?? phone(r.recipient.value)}</Link>{r.recipient.name && <span className="block text-sm text-muted">{phone(r.recipient.value)}</span>}</td>
                    <td className="px-4 py-3">{r.subtype && copy.request.subtype[r.subtype] ? copy.request.subtype[r.subtype] : ''}{r.category ?? ''}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{money(r.amountCents)}</td>
                    <td className="px-4 py-3"><code className="text-sm">{r.receipt ?? '—'}</code></td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
