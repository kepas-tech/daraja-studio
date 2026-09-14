import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import { Card, cardRow } from '../components/Card';
import { Flash } from '../components/Flash';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { STATUS_TONE } from '../components/RequestCard';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import type { BalanceView, Page, RequestView, SettingsView } from '../api/types';

const RELOAD_ON: readonly string[] = ['operator.updated', 'setup.updated', 'balance.updated'];
// The three things a business does most, as tiles above the fold.
const QUICK: { key: string; to: string }[] = [{ key: 'send', to: '/send/phone' }, { key: 'stk', to: '/ask-to-pay' }, { key: 'balances', to: '/balances' }];

export function Home() {
  const { person, refresh } = useSession();
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
  // A reconnect re-reads everything this page shows, for events lost while the stream was down.
  const reloadAll = useCallback(() => { load(); loadMoney(); void refresh(); }, [load, loadMoney, refresh]);
  useEvents(useCallback((e) => {
    if (RELOAD_ON.includes(e.type)) load();
    if (e.type === 'balance.updated' || e.type === 'request.updated') loadMoney();
    if (e.type === 'org.updated') void refresh();
  }, [load, loadMoney, refresh]), true, reloadAll);
  const active = v?.environments[v.mode];
  const alerts: string[] = [];
  if (active && !active.ready.operator) alerts.push(copy.home.noOperator);
  if (v && !v.publicVerifiedAt) alerts.push(copy.home.noPublicUrl);
  if (v && !v.stkEnabled) alerts.push(copy.home.stkOff);
  const settingsLabel = copy.nav.find((e) => e.key === 'settings')?.label ?? 'Settings';
  return (
    <>
      <PageHeader title={copy.home.welcome(person?.display_name ?? '')}>{v && <StatusPill kind={v.mode === 'production' ? 'ok' : 'muted'}>{v.mode}</StatusPill>}</PageHeader>
      {alerts.length > 0 && (
        <Flash tone="danger" className="mb-6">
          <p className="font-semibold">{copy.home.finishSetup}</p>
          <ul className="space-y-1">{alerts.map((a) => <li key={a}>{a} <Link to="/settings">{settingsLabel}</Link></li>)}</ul>
        </Flash>
      )}
      {alerts.length === 0 && v && <Flash tone="success" className="mb-6">{copy.home.connected}</Flash>}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {QUICK.map(({ key, to }) => {
          const e = copy.nav.find((n) => n.key === key);
          if (!e) return null;
          return (
            <Link key={key} to={to} className="flex items-start gap-3 rounded-md border border-line bg-surface p-4 text-ink hover:border-brand hover:no-underline">
              <Icon name={e.icon} className="mt-0.5 size-6 text-brand" />
              <span className="flex min-w-0 flex-col"><span className="font-semibold">{e.label}</span>{e.safaricom && <span className="text-xs text-muted">{e.safaricom}</span>}</span>
            </Link>
          );
        })}
      </div>
      <Card title={copy.home.latestBalance} className="mb-6">
        {balance ? (
          <p className="text-lg">
            <Link to="/balances">{copy.balances.utility}: <strong>{money(balance.utilityCents)}</strong> · {copy.balances.working}: <strong>{money(balance.workingCents)}</strong></Link>
            <span className="block text-sm text-muted">{copy.balances.asOf(when(balance.queriedAt))}</span>
          </p>
        ) : (
          <p className="text-base"><Link to="/balances">{copy.home.noBalance}</Link></p>
        )}
      </Card>
      <Card title={copy.home.recent} bodyClassName="p-0">
        {recent.length === 0 ? <p className="p-4 text-base text-muted">{copy.home.noRecent}</p> : (
          <ul>
            {recent.map((r) => <li key={r.id} className={`${cardRow} flex items-center justify-between gap-3 text-base`}><Link to={`/requests/${r.id}`}>{phone(r.recipient.value)}</Link><span>{money(r.amountCents)}</span><StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{copy.request.status[r.status] ?? r.status}</StatusPill></li>)}
          </ul>
        )}
      </Card>
    </>
  );
}
