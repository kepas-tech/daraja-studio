import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import { useEvents } from '../../api/events';
import type { BalanceView, BusinessCheck, BusinessView, Confirm, ContactView, RequestView } from '../../api/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { MoneyInput } from '../../components/MoneyInput';
import { PasswordConfirmDialog } from '../../components/PasswordConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { RequestCard } from '../../components/RequestCard';
import { Flash } from '../../components/Flash';
import { TaskCard } from '../../components/TaskCard';
import { Questionnaire } from '../../components/Questionnaire';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { money, when } from '../../format';

type Step = 'form' | 'review' | 'result';
const NUMBER = /^[0-9]{5,7}$/;
const ACCOUNT = /^[A-Za-z0-9]{1,20}$/;

/**
 * B2B: pay a paybill (with the account number it asks for) or a till. The same three steps as a
 * phone send — ask, review, result — except the money comes out of Working, and the review asks
 * Safaricom who the number is registered to instead of who a phone belongs to.
 */
export function PayBusiness({ to }: { to: 'paybill' | 'till' }) {
  const c = copy.payBusiness;
  const toast = useToast();
  const [step, setStep] = useState<Step>('form');
  const [shortcode, setShortcode] = useState(''); const [account, setAccount] = useState('');
  const [cents, setCents] = useState<number | null>(null); const [remarks, setRemarks] = useState('');
  const [businesses, setBusinesses] = useState<BusinessView[]>([]);
  const [businessId, setBusinessId] = useState('');
  useEffect(() => {
    api.get<{ items: BusinessView[]; lastUsedId: string | null }>('/api/businesses').then((r) => {
      const live = r.items.filter((b) => b.active);
      setBusinesses(live);
      setBusinessId((id) => id || (live.some((b) => b.id === r.lastUsedId) ? (r.lastUsedId as string) : (live[0]?.id ?? '')));
    }).catch(() => {});
  }, []);
  const [contacts, setContacts] = useState<ContactView[] | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  useEffect(() => { api.get<{ items: ContactView[] }>('/api/contacts?kind=' + to).then((r) => setContacts(r.items)).catch(() => setContacts([])); }, [to]);
  const [balance, setBalance] = useState<BalanceView | null | undefined>(undefined);
  const [cap, setCap] = useState<number | null>(null);
  const [check, setCheck] = useState<BusinessCheck | null | undefined>(undefined);
  const [charge, setCharge] = useState<number | null | undefined>(undefined);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [dialogError, setDialogError] = useState<Error | null>(null);
  const [duplicate, setDuplicate] = useState<{ at: string } | null>(null); const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [request, setRequest] = useState<RequestView | null>(null);
  const [round, setRound] = useState(0);

  const number = shortcode.trim();
  const acct = to === 'paybill' ? account.trim() : '';
  const numberOk = NUMBER.test(number);
  const accountOk = acct === '' || ACCOUNT.test(acct);
  const valid = numberOk && accountOk && cents !== null && cents > 0 && cents % 100 === 0;

  // ?contact=<id> from the Contacts page fills the number and the account.
  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    const id = search.get('contact');
    if (!id || !contacts) return;
    const picked = contacts.find((x) => x.id === id);
    if (picked) { setContactId(picked.id); setShortcode(picked.shortcode ?? ''); setAccount(picked.accountReference ?? ''); }
    setSearch((p) => { p.delete('contact'); return p; }, { replace: true });
  }, [search, contacts, setSearch]);

  useEffect(() => {
    if (step !== 'review') return;
    let live = true;
    setCheck(undefined); setCharge(undefined);
    api.get<BalanceView | null>('/api/balances/latest').then((b) => { if (live) setBalance(b); }).catch(() => { if (live) setBalance(null); });
    api.get<{ sendCapCents: number | null }>('/healthz').then((h) => { if (live) setCap(h.sendCapCents); }).catch(() => {});
    api.post<BusinessCheck>('/api/send/business-check', { to, shortcode: number }).then((r) => { if (live) setCheck(r); }).catch(() => { if (live) setCheck(null); });
    if (cents !== null) api.get<{ chargeCents: number | null }>(`/api/fees/charge?kind=b2b&amountCents=${cents}`).then((r) => { if (live) setCharge(r.chargeCents); }).catch(() => { if (live) setCharge(null); });
    return () => { live = false; };
  }, [step, to, number, cents]);

  const reload = useCallback((id: string) => api.get<RequestView>(`/api/requests/${id}`).then((r) => {
    setRequest((prev) => {
      if (prev && prev.status !== r.status && c.result[r.status]) toast.show(r.status === 'completed' ? 'success' : r.status === 'failed' ? 'error' : 'info', c.result[r.status]);
      return r;
    });
  }).catch(() => {}), [toast, c.result]);
  const requestIdRef = useRef<string | null>(null);
  requestIdRef.current = request?.id ?? null;
  useEvents(useCallback((e) => {
    const p = e.payload as { id?: string };
    const id = requestIdRef.current;
    if (e.type === 'request.updated' && id && p.id === id) void reload(id);
  }, [reload]), step === 'result', useCallback(() => { if (requestIdRef.current) void reload(requestIdRef.current); }, [reload]));
  useEffect(() => {
    if (step !== 'result' || request?.status !== 'sent') return;
    const t = setInterval(() => { if (requestIdRef.current) void reload(requestIdRef.current); }, 15_000);
    return () => clearInterval(t);
  }, [step, request?.status, reload]);

  const submit = async (pw: Confirm) => {
    setBusy(true); setDialogError(null);
    try {
      const r = await api.post<RequestView>('/api/send/business', {
        to, shortcode: number, accountReference: acct || undefined, amountCents: cents, remarks: remarks || undefined,
        contactId: contactId ?? undefined, businessId: businessId || undefined,
        recipientName: check?.available ? check.name : undefined, confirmDuplicate: confirmDuplicate || undefined, ...pw,
      });
      setRequest(r); setConfirm(false); setDuplicate(null); setConfirmDuplicate(false); setStep('result');
      toast.show(r.status === 'completed' ? 'success' : r.status === 'failed' ? 'error' : 'info', c.result[r.status] ?? r.status);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate_recent') { setConfirm(false); setDuplicate({ at: (e.details as { at: string }).at }); }
      else setDialogError(e instanceof ApiError ? e : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };

  const reset = () => { setRound((n) => n + 1); setStep('form'); setShortcode(''); setAccount(''); setCents(null); setRemarks(''); setContactId(null); setRequest(null); setDuplicate(null); setConfirmDuplicate(false); };

  const pickedContact = contacts?.find((x) => x.id === contactId) ?? null;
  const workingAfter = balance?.workingCents != null && cents !== null ? balance.workingCents - cents - (charge ?? 0) : null;
  const short = workingAfter !== null && workingAfter < 0;
  const overCap = cap !== null && cents !== null && cents > cap;
  const nameLine = check === undefined ? c.review.checking
    : check?.available ? c.review.name(check.name)
    : check?.reason === 'not_found' ? null
    : c.review.unavailable;
  const firstTime = check != null && check.paidBefore === false;

  return (
    <>
      <PageHeader title={c.title[to]} safaricom={c.safaricom[to]} />
      {step === 'form' && (
        <Questionnaire key={round} intro={c.intro} doneLabel={c.next} onDone={() => { if (valid) setStep('review'); }} steps={[
          ...(businesses.length > 1 ? [{
            key: 'business', question: c.business, valid: !!businessId,
            render: () => (
              <select aria-label={c.business} className="min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink" value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
                {businesses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
              </select>
            ),
          }] : []),
          { key: 'number', question: c.number[to], valid: numberOk, render: () => (
            <div className="space-y-3">
              {(contacts?.length ?? 0) > 0 && (
                <div>
                  <label htmlFor="pay-contact" className="mb-1 block text-base font-semibold">{c.fromContacts.label}</label>
                  <select
                    id="pay-contact" aria-label={c.fromContacts.label}
                    className="min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink"
                    value={contactId ?? ''}
                    onChange={(e) => { const picked = contacts?.find((x) => x.id === e.target.value) ?? null; setContactId(picked?.id ?? null); if (picked) { setShortcode(picked.shortcode ?? ''); setAccount(picked.accountReference ?? ''); } }}
                  >
                    <option value="">{c.fromContacts.pick}</option>
                    {(contacts ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.shortcode}{x.accountReference ? ' · ' + x.accountReference : ''}</option>)}
                  </select>
                </div>
              )}
              {contacts?.length === 0 && <p className="text-sm"><Link to="/contacts">{c.fromContacts.manage}</Link></p>}
              {/* Typing a number is the person's own choice: the saved contact no longer applies. */}
              <TextField label={c.number[to]} labelHidden inputMode="numeric" value={shortcode} onChange={(e) => { setShortcode(e.target.value); setContactId(null); }}
                error={shortcode.trim() && !numberOk ? c.badNumber : undefined} autoFocus />
            </div>
          ) },
          ...(to === 'paybill' ? [{ key: 'account', question: c.account, valid: accountOk, render: () => (
            <TextField label={c.account} labelHidden hint={c.accountHint} value={account} maxLength={20}
              onChange={(e) => { setAccount(e.target.value); setContactId(null); }} error={!accountOk ? c.badAccount : undefined} autoFocus />
          ) }] : []),
          { key: 'amount', question: c.amount, valid: cents !== null && cents > 0 && cents % 100 === 0, render: () => <MoneyInput label={c.amount} labelHidden valueCents={cents} onChange={setCents} wholeShillings autoFocus /> },
          { key: 'note', question: c.remarks, optional: true, valid: true, empty: !remarks, render: () => <TextField label={c.remarks} labelHidden value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={100} autoFocus /> },
        ]} />
      )}

      {step === 'review' && (
        <div className="max-w-xl space-y-4">
          <TaskCard
            footerStart={<Button type="button" variant="secondary" onClick={() => { setStep('form'); setConfirmDuplicate(false); setDuplicate(null); }}>{c.back}</Button>}
            footer={<Button type="button" disabled={short || overCap || busy} onClick={() => { setDialogError(null); setConfirm(true); }}>{c.pay}</Button>}
          >
            <h2 className="text-xl font-semibold">{c.review.title}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
              <dt className="text-muted">{c.number[to]}</dt>
              <dd>{number}
                {pickedContact && <span className="block text-sm text-muted">{c.fromContacts.saved(pickedContact.name)}</span>}
                {nameLine && <span className="block text-sm text-muted" data-testid="business-name">{nameLine}</span>}
              </dd>
              {to === 'paybill' && <><dt className="text-muted">{c.review.account}</dt><dd>{acct || c.review.noAccount}</dd></>}
              <dt className="text-muted">{copy.request.amount}</dt><dd>{money(cents)}</dd>
              <dt className="text-muted">{c.review.chargeLabel}</dt>
              <dd>{charge === undefined ? copy.app.loading : charge === null ? c.review.chargeNone : c.review.charge(money(charge))}</dd>
              {businesses.length > 1 && <><dt className="text-muted">{copy.businesses.title}</dt><dd>{businesses.find((b) => b.id === businessId)?.name ?? '—'}</dd></>}
              <dt className="text-muted">{c.review.balanceNow}</dt>
              <dd>{balance === undefined ? copy.app.loading : balance === null || balance.workingCents === null ? c.review.balanceMissing : money(balance.workingCents)}
                {balance?.queriedAt && <span className="block text-sm text-muted">{when(balance.queriedAt)}</span>}</dd>
              {workingAfter !== null && <><dt className="text-muted">{c.review.balanceAfter}</dt><dd>{money(workingAfter)}</dd></>}
            </dl>
            <p className="text-sm text-muted">{c.review.debits}</p>
            <p className="text-sm text-muted">{c.review.nameAfter}</p>
            {cap !== null && <p className="text-sm text-muted">{c.review.cap(money(cap))}</p>}
            {check?.available === false && check.reason === 'not_found' && <Flash tone="danger" role="alert">{c.review.notFound}</Flash>}
            {firstTime && <Flash tone="neutral" role="alert" data-testid="first-time">{c.review.firstTime}</Flash>}
            {short && <Flash tone="danger" role="alert">{c.review.short}</Flash>}
            {duplicate && (
              <Flash tone="neutral" role="alert">
                <p>{c.duplicate(when(duplicate.at))}</p>
                <div className="flex gap-2 pt-1">
                  <Button type="button" onClick={() => { setConfirmDuplicate(true); setDuplicate(null); setConfirm(true); }}>{c.duplicateYes}</Button>
                  <Button type="button" variant="secondary" onClick={() => { setDuplicate(null); setConfirmDuplicate(false); toast.info(c.duplicateCancelled); }}>{c.duplicateNo}</Button>
                </div>
              </Flash>
            )}
          </TaskCard>
          <PasswordConfirmDialog open={confirm} title={c.confirmTitle(money(cents), check?.available ? check.name : number)} busy={busy} error={dialogError} onConfirm={(pw) => void submit(pw)} onCancel={() => setConfirm(false)} />
        </div>
      )}

      {step === 'result' && request && (
        <div className="max-w-xl space-y-4">
          <p role="status" className="text-lg font-semibold">{c.result[request.status] ?? request.status}</p>
          <RequestCard request={request}>
            {request.status === 'completed' && <Button type="button" onClick={reset}>{c.result.payAnother}</Button>}
            {request.status === 'unknown' && <Link className="text-base" to={`/requests/${request.id}`}>{copy.request.markChecked}</Link>}
          </RequestCard>
        </div>
      )}
    </>
  );
}
