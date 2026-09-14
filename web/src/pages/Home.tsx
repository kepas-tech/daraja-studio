import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { STATUS_TONE } from '../components/RequestCard';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import type { BalanceView, Page, RequestView, SettingsView } from '../api/types';

const RELOAD_ON: readonly string[] = ['operator.updated', 'setup.updated', 'balance.updated'];

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
  return (
    <>
      <PageHeader title={copy.home.welcome(person?.display_name ?? '')}>{v && <StatusPill kind={v.mode === 'production' ? 'ok' : 'warn'}>{v.mode}</StatusPill>}</PageHeader>
      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
        <h2 className="text-base text-gray-600 dark:text-gray-400">{copy.home.latestBalance}</h2>
        {balance ? (
          <p className="text-lg">
            <Link className="underline" to="/balances">{copy.balances.utility}: <strong>{money(balance.utilityCents)}</strong> · {copy.balances.working}: <strong>{money(balance.workingCents)}</strong></Link>
            <span className="block text-sm text-gray-500">{copy.balances.asOf(when(balance.queriedAt))}</span>
          </p>
        ) : (
          <p className="text-base"><Link className="underline" to="/balances">{copy.home.noBalance}</Link></p>
        )}
      </section>
      <section className="mb-6">
        <h2 className="mb-2 text-base text-gray-600 dark:text-gray-400">{copy.home.recent}</h2>
        {recent.length === 0 ? <p className="text-base">{copy.home.noRecent}</p> : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-950">
            {recent.map((r) => <li key={r.id} className="flex items-center justify-between px-4 py-2 text-base"><Link className="underline" to={`/requests/${r.id}`}>{phone(r.recipient.value)}</Link><span>{money(r.amountCents)}</span><StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{copy.request.status[r.status] ?? r.status}</StatusPill></li>)}
          </ul>
        )}
      </section>
      <ul className="space-y-2">{alerts.map((a) => <li key={a} className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30">{a} <Link className="underline" to="/settings">Settings</Link></li>)}</ul>
      {alerts.length === 0 && v && <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:bg-emerald-950/30">{copy.home.connected}</p>}
    </>
  );
}
