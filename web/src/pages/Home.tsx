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
import { money } from '../format';
import { PartyLine } from '../components/PartyLine';
import { plural, typeOf } from '../businessTypes';
import type { BalanceView, BusinessSummaryRow, HomeSummary, Page, Problem, RequestView, SettingsView } from '../api/types';

const RELOAD_ON: readonly string[] = ['operator.updated', 'setup.updated', 'balance.updated'];
// The three things a business does most, as tiles above the fold.
const QUICK: { key: string; to: string }[] = [{ key: 'send', to: '/send/phone' }, { key: 'stk', to: '/ask-to-pay' }, { key: 'history', to: '/history' }];

export function Home() {
  const { person, org, refresh } = useSession();
  const [v, setV] = useState<SettingsView | null>(null);
  const [balance, setBalance] = useState<BalanceView | null | undefined>(undefined);
  const [recent, setRecent] = useState<RequestView[]>([]);
  // Feature 2: one line per business once there is more than one. Their own history, never cash:
  // M-Pesa holds one pool per shortcode.
  const [byBusiness, setByBusiness] = useState<BusinessSummaryRow[]>([]);
  // Feature 6: the last 24 hours, in one strip under the balance. Null until the read lands, and
  // left null if it fails: a summary that is missing is quieter than an error where it belongs.
  const [today, setToday] = useState<HomeSummary | null>(null);
  // Brief 2, item 2: the states that mean something is wrong. Read with the rest of the page and
  // re-read whenever anything happens, so the banner goes as soon as the state behind it clears.
  const [problems, setProblems] = useState<Problem[]>([]);
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
    api.get<{ items: BusinessSummaryRow[] }>('/api/businesses/summary').then((r) => setByBusiness(r.items)).catch(() => setByBusiness([]));
    api.get<HomeSummary>('/api/reports/summary').then(setToday).catch(() => setToday(null));
    // `?? []` as well as the catch: a server that answered with an unexpected shape must not take the
    // whole page down over a banner that is only ever extra.
    api.get<{ items: Problem[] }>('/api/health/problems').then((r) => setProblems(r.items ?? [])).catch(() => setProblems([]));
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
  // The kind of business the studio is, when there is exactly one, and the line its type leads with.
  const only = byBusiness.length === 1 ? byBusiness[0] : null;
  const onlyType = only ? typeOf(only) : null;
  const leadKey = onlyType?.template.homeLead ?? 'nothing';
  const leadLine = !today || !only || !onlyType ? null
    : leadKey === 'behind' ? copy.home.lead.behind(only.accountCount ?? 0, plural(onlyType.template.accountNoun))
    : leadKey === 'takings' ? copy.home.lead.takings(money(today.inCents), today.inCount)
    : leadKey === 'giving' ? copy.home.lead.giving(money(today.monthInCents))
    : leadKey === 'outstanding' ? copy.home.lead.outstanding(money(today.unpaidInvoiceCents), today.unpaidInvoiceCount)
    : null;
  const active = v?.environments[v.mode];
  const alerts: string[] = [];
  if (active && !active.ready.operator) alerts.push(copy.home.noOperator);
  if (v && !v.publicVerifiedAt) alerts.push(copy.home.noPublicUrl);
  if (v && !v.stkEnabled) alerts.push(copy.home.stkOff);
  const settingsLabel = copy.nav.find((e) => e.key === 'settings')?.label ?? 'Settings';
  return (
    <>
      <PageHeader title={org?.safaricomName ?? org?.name ?? copy.appName} subtitle={org ? copy.home.shortcodeLine(org.shortcode ?? null, org.environment, org.safaricomName ? org.name : null, org.shortcodeKind) : null} />
      {problems.length > 0 && (
        <Flash tone="danger" className="mb-6" data-testid="home-problems">
          <p className="font-semibold">{copy.home.problems.title}</p>
          <ul className="space-y-1">
            {problems.map((x) => (
              <li key={x.kind}>
                {copy.home.problems.sentence[x.kind]}{' '}
                <Link to={copy.home.problems.to[x.kind] ?? '/settings'}>{copy.home.problems.open[x.kind] ?? copy.nav.find((e) => e.key === 'settings')?.label}</Link>
                {x.detail && <span className="block text-sm">{copy.home.problems.detail[x.kind]?.(x.detail)}</span>}
              </li>
            ))}
          </ul>
        </Flash>
      )}
      {alerts.length > 0 && (
        <Flash tone="danger" className="mb-6">
          <p className="font-semibold">{copy.home.finishSetup}</p>
          <ul className="space-y-1">{alerts.map((a) => <li key={a}>{a} <Link to="/settings">{settingsLabel}</Link></li>)}</ul>
        </Flash>
      )}
      <ErrorCardSlot error={balances.err} />
      <BalanceHero balance={balance} message={balances.msg} className="mb-2" action={<Button type="button" variant="secondary" onClick={() => void balances.refresh()} disabled={balances.busy}>{balances.busy ? copy.balances.refreshing : copy.balances.refresh}</Button>} />
      {today && (
        <div data-testid="home-today" className="mt-2 mb-6 rounded-md border border-line bg-surface px-4 py-3 text-base">
          {/* Round 3, phase B: what Home leads with follows the kind of business, when the studio
              has one. With several, each business's own words are on its row below. */}
          {leadLine && <p data-testid="home-lead" className="mb-1 font-semibold">{leadLine}</p>}
          <p><span className="font-semibold">{copy.home.today.last24h}</span>{' · '}{copy.home.today.in(money(today.inCents), today.inCount)} · {copy.home.today.out(money(today.outCents), today.outCount)}</p>
          <p className="text-sm text-muted">{copy.home.today.waiting(today.pending)} · {copy.home.today.failed(today.failed)}</p>
        </div>
      )}
      {alerts.length === 0 && v && <p className="mb-6 text-sm text-muted">{copy.home.connected}</p>}
      {isOwner && v?.mode === 'sandbox' && (
        <Flash tone="neutral" className="mb-6" data-testid="sandbox-banner">
          <p>{copy.home.sandboxBanner} <Link to="/go-live">{copy.home.goLive}</Link></p>
        </Flash>
      )}
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
      {byBusiness.length > 1 && (
        <Card className="mb-6" title={copy.home.byBusiness} bodyClassName="p-0">
          <ul>
            {byBusiness.map((b) => (
              <li key={b.businessId} data-testid={'home-business-' + b.businessId} className={cardRow + ' flex flex-wrap items-center justify-between gap-3 text-base'}>
                <span className="min-w-0"><code>{b.code}</code> · {b.name}<span className="block text-sm text-muted">{copy.businesses.kind(typeOf(b).name)}</span></span>
                <span className="text-sm"><span className="text-muted">{copy.home.in} </span>{money(b.inCents)}<span className="text-muted"> · {copy.home.out} </span>{money(b.outCents)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title={copy.home.recent} bodyClassName="p-0" actions={<Link to="/history" className="text-sm">{copy.home.viewAll}</Link>}>
        {recent.length === 0 ? <p className="p-4 text-base text-muted">{copy.home.noRecent}</p> : (
          <ul>
            {/* Round 3, phase A: the person leads here too — this list used to show a number alone. */}
            {recent.map((r) => <li key={r.id} className={`${cardRow} flex items-center justify-between gap-3 text-base`}><PartyLine r={r} to={`/requests/${r.id}`} /><span>{money(r.amountCents)}</span><StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{copy.request.status[r.status] ?? r.status}</StatusPill></li>)}
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
