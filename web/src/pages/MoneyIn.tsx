import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import type { AccountView, BusinessView, MoneyInView, Page, RequestView, UnmatchedView } from '../api/types';
import { TextField } from '../components/TextField';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, toastText, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import { PartyLine, partyOf } from '../components/PartyLine';
import { useStepUp } from './settings/useStepUp';


/**
 * One payment the account number did not sort, and the one-click fix for it. Nothing here moves or
 * changes money: the row's amount, receipt and status are untouched, and an audit row records who
 * decided what (brief 2, item 1). The fix is always an assign — no number is ever typed by a person,
 * because Studio mints every number and a typed one could belong to somebody else.
 */
function UnmatchedRow({ row, businesses, onDone }: { row: UnmatchedView; businesses: BusinessView[]; onDone: () => void }) {
  const c = copy.moneyIn.unmatched;
  const toast = useToast();
  const fallback = businesses.find((b) => b.name === row.businessName) ?? null;
  const known = businesses.find((b) => b.id === row.businessId) ?? fallback;
  const [businessId, setBusinessId] = useState(row.businessId ?? '');
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [accountId, setAccountId] = useState('');
  const [name, setName] = useState(row.recipient.name ?? '');
  const [busy, setBusy] = useState(false);
  const reference = (row.accountReference ?? '').trim();

  useEffect(() => {
    if (!known) return;
    let alive = true;
    api.get<{ items: AccountView[] }>('/api/businesses/' + known.id + '/accounts')
      .then((r) => { if (alive) setAccounts(r.items); })
      .catch(() => { if (alive) setAccounts([]); });
    return () => { alive = false; };
  }, [known?.id]);

  const assign = async (bizId: string, accId?: string) => {
    setBusy(true);
    try {
      await api.post('/api/businesses/assign/' + row.id, { businessId: bizId, accountId: accId || undefined });
      toast.success(c.assigned);
      onDone();
    } catch (e) { toast.error(toastText(e)); } finally { setBusy(false); }
  };
  // Adding a customer here is the same as adding one on the Businesses page: Studio draws the
  // number, and the payment is then labelled with the new account.
  const addAndAssign = async () => {
    if (!known) return;
    setBusy(true);
    try {
      const made = await api.post<AccountView>('/api/businesses/' + known.id + '/accounts', { name: name.trim() || c.newCustomerName });
      await api.post('/api/businesses/assign/' + row.id, { businessId: known.id, accountId: made.id });
      toast.success(c.assigned);
      onDone();
    } catch (e) { toast.error(toastText(e)); } finally { setBusy(false); }
  };
  const control = 'min-h-10 rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  const line = row.reason === 'no_business' ? c.noBusiness(reference || '—')
    : row.reason === 'no_account' ? c.noAccount(reference || '—')
    : row.reason === 'no_sub' ? c.noSub(reference || '—', row.accountName ?? null)
    : c.tooMany(reference || '—');

  return (
    <li data-testid={'unmatched-' + row.id} className={cardRow + ' space-y-3'}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="min-w-0">
          <span className="text-base font-medium">{partyOf(row).name ?? phone(row.recipient.value)}</span>
          <span className="block text-sm text-muted">{when(row.sentAt ?? row.createdAt)} · {c.from}: {phone(row.recipient.value)}</span>
        </span>
        <span className="text-base font-semibold">{money(row.amountCents)}</span>
      </div>
      <p className="text-base">{line}</p>
      {row.reason === 'no_business' && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-sm text-muted">{c.whichBusiness}</span>
            <select aria-label={c.whichBusiness} className={control} value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">—</option>
              {businesses.filter((b) => b.active).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
            </select>
          </label>
          <Button type="button" disabled={!businessId || busy} onClick={() => void assign(businessId)}>{c.assign}</Button>
        </div>
      )}
      {row.reason !== 'no_business' && known && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-sm text-muted">{c.orExisting}</span>
              <select aria-label={c.orExisting} className={control} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">{c.none}</option>
                {accounts.map((x) => (
                  <optgroup key={x.id} label={x.name + ' · ' + x.fullNumber}>
                    <option value={x.id}>{x.name} · {x.fullNumber}</option>
                    {x.children.map((k) => <option key={k.id} value={k.id}>{k.name} · {k.fullNumber}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <Button type="button" variant="secondary" disabled={!accountId || busy} onClick={() => void assign(known.id, accountId)}>{c.assign}</Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <TextField label={copy.businesses.customerName} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            <Button type="button" disabled={busy} onClick={() => void addAndAssign()}>{c.addCustomer(known.name)}</Button>
          </div>
        </div>
      )}
      {row.reason !== 'no_business' && !known && <p className="text-sm text-muted">{c.whichBusiness}</p>}
    </li>
  );
}
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
  // Feature 2: payments the account number did not sort, and the businesses to sort them into.
  const [unmatched, setUnmatched] = useState<UnmatchedView[]>([]);
  const [businesses, setBusinesses] = useState<BusinessView[]>([]);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<number | null>(null);
  const justStarted = useRef(false);

  const load = useCallback(async () => {
    const [v, r, u, b] = await Promise.all([
      api.get<MoneyInView>('/api/money-in/status'),
      api.get<Page<RequestView>>('/api/money-in/recent'),
      api.get<{ items: UnmatchedView[] }>('/api/money-in/unmatched').catch(() => ({ items: [] })),
      api.get<{ items: BusinessView[] }>('/api/businesses').catch(() => ({ items: [] })),
    ]);
    setView(v); setRecent(r.items); setUnmatched(u.items); setBusinesses(b.items);
  }, []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'request.updated' || e.type === 'money_in.updated') void load().catch(() => {}); }, [load]));
  // While Safaricom is being told where to post, re-read every few seconds until the answer lands.
  useEffect(() => {
    if (!view?.registering) return;
    const t = setInterval(() => { void load().catch(() => {}); }, 3000);
    return () => clearInterval(t);
  }, [view?.registering, load]);

  const turnOn = () => stepUp.ask(c.confirmTurnOn, async (confirm) => {
    const v = await api.post<MoneyInView>('/api/money-in/register', { ...confirm });
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
          {!view.registering && on && view.alreadyRegistered && <Flash tone="neutral">{c.alreadyRegistered}</Flash>}
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
        {unmatched.length > 0 && (
          <Card title={c.unmatched.title} bodyClassName="p-0">
            <p className="p-4 text-base text-muted">{c.unmatched.intro}</p>
            <ul>{unmatched.map((r) => <UnmatchedRow key={r.id} row={r} businesses={businesses} onDone={() => void load().catch(() => {})} />)}</ul>
          </Card>
        )}
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
                    <td className="px-4 py-3"><PartyLine r={r} to={`/requests/${r.id}`} /></td>
                    <td className="px-4 py-3">{r.accountReference ?? ''}{r.accountName && (r.accountId ? <Link className="block text-sm" to={'/history?account=' + r.accountId + '&accountName=' + encodeURIComponent(r.accountName)}>{r.accountName}</Link> : <span className="block text-sm text-muted">{r.accountName}</span>)}</td>
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