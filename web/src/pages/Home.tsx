import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { useBalanceRefresh } from '../api/useBalanceRefresh';
import { useSession } from '../app/session';
import { BalanceHero } from '../components/BalanceHero';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { Flash } from '../components/Flash';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { STATUS_TONE } from '../components/RequestCard';
import { copy } from '../copy/en';
import { money, phone } from '../format';
import type { BalanceView, Page, RequestView, SettingsView } from '../api/types';

const RELOAD_ON: readonly string[] = ['operator.updated', 'setup.updated', 'balance.updated'];
// The three things a business does most, as tiles above the fold.
const QUICK: { key: string; to: string }[] = [{ key: 'send', to: '/send/phone' }, { key: 'stk', to: '/ask-to-pay' }, { key: 'history', to: '/history' }];

export function Home() {
  const { person, org, refresh } = useSession();
  const [v, setV] = useState<SettingsView | null>(null);
  const [balance, setBalance] = useState<BalanceView | null | undefined>(undefined);
  const [recent, setRecent] = useState<RequestView[]>([]);
  // These callbacks depend on primitives, never on the whole person object: SessionProvider sets a
  // new person object on every refresh, and depending on it changed the event handler and
  // reloadAll identity, so useEvents closed and reopened the stream whose own open refreshes the
  // session again (PB1-F1). The primitives keep the connection stable and the reads current.
  const personId = person?.id ?? null;
  const isOwner = person?.is_owner === true;
  const load = useCallback(() => { if (isOwner) api.get<SettingsView>('/api/settings').then(setV).catch(() => setV(null)); }, [isOwner]);
  const loadMoney = useCallback(() => {
    if (!personId) return;
    api.get<BalanceView | null>('/api/balances/latest').then(setBalance).catch(() => setBalance(null));
    api.get<Page<RequestView>>('/api/requests?limit=5').then((p) => setRecent(p.items)).catch(() => setRecent([]));
  }, [personId]);
  useEffect(load, [load]);
  useEffect(loadMoney, [loadMoney]);
  const balances = useBalanceRefresh(loadMoney);
  // A reconnect re-reads everything this page shows, for events lost while the stream was down.
  const reloadAll = useCallback(() => { load(); loadMoney(); void refresh(); balances.checkPending(); }, [load, loadMoney, refresh, balances.checkPending]);
  useEvents(useCallback((e) => {
    balances.onEvent(e);
    if (RELOAD_ON.includes(e.type)) load();
    if (e.type === 'balance.updated' || e.type === 'request.updated') loadMoney();
    if (e.type === 'org.updated') void refresh();
  }, [load, loadMoney, refresh, balances.onEvent]), true, reloadAll);
  const active = v?.environments[v.mode];
  const alerts: string[] = [];
  if (active && !active.ready.operator) alerts.push(copy.home.noOperator);
  if (v && !v.publicVerifiedAt) alerts.push(copy.home.noPublicUrl);
  if (v && !v.stkEnabled) alerts.push(copy.home.stkOff);
  const settingsLabel = copy.nav.find((e) => e.key === 'settings')?.label ?? 'Settings';
  return (
    <>
      <PageHeader title={org?.safaricomName ?? org?.name ?? copy.appName} subtitle={org ? copy.home.shortcodeLine(org.shortcode ?? null, org.environment, org.safaricomName ? org.name : null) : null} />
      {alerts.length > 0 && (
        <Flash tone="danger" className="mb-6">
          <p className="font-semibold">{copy.home.finishSetup}</p>
          <ul className="space-y-1">{alerts.map((a) => <li key={a}>{a} <Link to="/settings">{settingsLabel}</Link></li>)}</ul>
        </Flash>
      )}
      <ErrorCardSlot error={balances.err} />
      <BalanceHero balance={balance} message={balances.msg} className="mb-2" action={<Button type="button" variant="secondary" onClick={() => void balances.refresh()} disabled={balances.busy}>{balances.busy ? copy.balances.refreshing : copy.balances.refresh}</Button>} />
      {alerts.length === 0 && v && <p className="mb-6 text-sm text-muted">{copy.home.connected}</p>}
      <div className="my-6 grid gap-3 sm:grid-cols-3">
        {QUICK.map(({ key, to }) => {
          const e = copy.nav.find((n) => n.key === key);
          if (!e) return null;
          return (
            <Link key={key} to={to} className="flex items-center gap-3 rounded-md border border-line bg-surface p-4 text-ink hover:border-brand hover:no-underline">
              <Icon name={e.icon} className="size-6 text-brand" />
              <span className="font-semibold">{e.label}</span>
            </Link>
          );
        })}
      </div>
      <Card title={copy.home.recent} bodyClassName="p-0" actions={<Link to="/history" className="text-sm">{copy.home.viewAll}</Link>}>
        {recent.length === 0 ? <p className="p-4 text-base text-muted">{copy.home.noRecent}</p> : (
          <ul>
            {recent.map((r) => <li key={r.id} className={`${cardRow} flex items-center justify-between gap-3 text-base`}><Link to={`/requests/${r.id}`}>{phone(r.recipient.value)}</Link><span>{money(r.amountCents)}</span><StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{copy.request.status[r.status] ?? r.status}</StatusPill></li>)}
          </ul>
        )}
      </Card>
    </>
  );
}

function ErrorCardSlot({ error }: { error: Error | { safaricomSaid: string; meaning: string; whatToDo: string } | null }) {
  if (!error) return null;
  return <div className="mb-6"><Flash tone="danger" role="alert">{'safaricomSaid' in error ? error.safaricomSaid : error.message}</Flash></div>;
}
