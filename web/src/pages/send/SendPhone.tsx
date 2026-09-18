import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, ApiError } from '../../api/client';
import type { Confirm } from '../../api/types';
import { useEvents } from '../../api/events';
import type { BalanceView, BusinessView, ContactView, NameCheck, RequestView, SendCategory } from '../../api/types';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { MoneyInput } from '../../components/MoneyInput';
import { PhoneInput } from '../../components/PhoneInput';
import { PasswordConfirmDialog } from '../../components/PasswordConfirmDialog';
import { PageHeader } from '../../components/PageHeader';
import { RequestCard } from '../../components/RequestCard';
import { ErrorCard } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { Segmented } from '../../components/Segmented';
import { TaskCard } from '../../components/TaskCard';
import { Questionnaire } from '../../components/Questionnaire';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { money, normalizeKe, phone, when } from '../../format';

type Step = 'form' | 'review' | 'result';
const STALE_MS = 24 * 3600 * 1000;

export function SendPhone() {
  const toast = useToast();
  const [step, setStep] = useState<Step>('form');
  const { person } = useSession();
  const [to, setTo] = useState(''); const [cents, setCents] = useState<number | null>(null); const [kind, setKind] = useState(''); const [remarks, setRemarks] = useState('');
  // Feature 2: which business the money is from. Nothing to choose while there is one, so the
  // question is only asked from the second business on; the last one used is the default.
  const [businesses, setBusinesses] = useState<BusinessView[]>([]);
  const [businessId, setBusinessId] = useState('');
  useEffect(() => {
    api.get<{ items: BusinessView[]; lastUsedId: string | null }>('/api/businesses').then((r) => {
      const live = r.items.filter((b) => b.active);
      setBusinesses(live);
      setBusinessId((id) => id || (live.some((b) => b.id === r.lastUsedId) ? (r.lastUsedId as string) : (live[0]?.id ?? '')));
    }).catch(() => {});
  }, []);
  const [categories, setCategories] = useState<SendCategory[]>([]);
  useEffect(() => { api.get<{ items: SendCategory[] }>('/api/send/categories').then((r) => { setCategories(r.items); setKind((k) => k || r.items[0]?.name || ''); }).catch(() => {}); }, []);
  // The saved phone contacts, for the picker. Reading them needs no permission: the picker must
  // work for whoever may send (design 2026-09-16). `null` until the answer arrives, so a
  // ?contact= prefill waits for the list instead of guessing.
  const [contacts, setContacts] = useState<ContactView[] | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  useEffect(() => { api.get<{ items: ContactView[] }>('/api/contacts?kind=phone').then((r) => setContacts(r.items)).catch(() => setContacts([])); }, []);
  const [balance, setBalance] = useState<BalanceView | null | undefined>(undefined);
  const [cap, setCap] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [dialogError, setDialogError] = useState<Error | null>(null);
  const [duplicate, setDuplicate] = useState<{ at: string } | null>(null); const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [againUnavailable, setAgainUnavailable] = useState(false);
  const [request, setRequest] = useState<RequestView | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  // Bumped on every reset so the questionnaire starts again at its first question.
  const [round, setRound] = useState(0);

  const normalised = normalizeKe(to);
  // Until the categories arrive (or if they never do) the server's default kind applies.
  const valid = !!normalised && cents !== null && cents % 100 === 0 && (categories.length === 0 || !!kind);

  useEffect(() => { if (step === 'review') api.get<BalanceView | null>('/api/balances/latest').then(setBalance).catch(() => setBalance(null)); }, [step]);
  // The name Safaricom holds for the number, asked once per review. `undefined` = asking,
  // `null` = Studio could not ask (the page then says what it always said: check the number).
  const [nameCheck, setNameCheck] = useState<NameCheck | null | undefined>(undefined);
  useEffect(() => {
    if (step !== 'review') return;
    let live = true;
    setNameCheck(undefined);
    api.post<NameCheck>('/api/send/name-check', { phone: normalised }).then((r) => { if (live) setNameCheck(r); }).catch(() => { if (live) setNameCheck(null); });
    return () => { live = false; };
  }, [step, normalised]);
  const nameLine = nameCheck === undefined ? copy.send.phone.review.nameChecking
    : nameCheck?.available ? copy.send.phone.review.name(nameCheck.name)
    : nameCheck?.reason === 'not_enabled' ? copy.send.phone.review.nameNotEnabled
    : copy.send.phone.review.nameNote;
  const unknownNumber = nameCheck != null && !nameCheck.available && nameCheck.reason === 'not_found';
  // W5 (spec §10): the cap is enforced server-side (service.ts) regardless — this is only so the
  // operator sees it before typing their password rather than after a 409 in the dialog.
  useEffect(() => { if (step === 'review') api.get<{ sendCapCents: number | null }>('/healthz').then((h) => setCap(h.sendCapCents)).catch(() => {}); }, [step]);
  // Feature 11: what Safaricom charges for this send, asked once per review. `undefined` = still
  // asking; `null` = no band covers this amount, and the line says so instead of showing a zero
  // that would read as free.
  const [charge, setCharge] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (step !== 'review' || cents === null) return;
    let live = true;
    setCharge(undefined);
    api.get<{ chargeCents: number | null }>(`/api/fees/charge?kind=b2c&amountCents=${cents}`)
      .then((r) => { if (live) setCharge(r.chargeCents); })
      .catch(() => { if (live) setCharge(null); });
    return () => { live = false; };
  }, [step, cents]);

  const [search, setSearch] = useSearchParams();
  useEffect(() => {
    const again = search.get('again');
    if (!again) return;
    setAgainUnavailable(false);
    api.get<RequestView>(`/api/requests/${again}`).then((prev) => {
      setTo(prev.recipient.value ?? ''); setCents(prev.amountCents); if (prev.category) setKind(prev.category); setRemarks(prev.remarks ?? ''); setConfirmDuplicate(true); setStep('review');
    }).catch(() => { setAgainUnavailable(true); }).finally(() => { setSearch((p) => { p.delete('again'); return p; }, { replace: true }); });
  }, [search, setSearch]);

  // ?contact=<id> arrives from the Contacts page: fill the number as well as the id, then drop the
  // param so a reload does not re-apply a number the operator has since changed.
  useEffect(() => {
    const id = search.get('contact');
    if (!id || !contacts) return;
    const picked = contacts.find((c) => c.id === id);
    if (picked) { setContactId(picked.id); setTo(picked.phone ?? ''); }
    setSearch((p) => { p.delete('contact'); return p; }, { replace: true });
  }, [search, contacts, setSearch]);

  const reload = useCallback((id: string) => api.get<RequestView>(`/api/requests/${id}`).then((r) => {
    setRequest((prev) => {
      if (prev && prev.status !== r.status) {
        if (r.status === 'completed') toast.success(copy.send.phone.result.completed);
        else if (r.status === 'failed') toast.error(copy.send.phone.result.failed);
        else if (r.status === 'unknown') toast.info(copy.send.phone.result.unknown);
      }
      return r;
    });
  }).catch(() => {}), [toast]);
  const requestIdRef = useRef<string | null>(null);
  requestIdRef.current = request?.id ?? null;
  // W2: re-fetch on every SSE (re)connect, not only on an event that might never arrive, and keep
  // polling every 15 s while the card still says "Sent" — never a busy loop, cleared on unmount
  // or once the result is in.
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

  const submit = async (confirm: Confirm) => {
    setBusy(true); setDialogError(null); setErr(null);
    try {
      // Round 3, phase A: the name Safaricom just confirmed goes with the payment, so the row is
      // named from the moment it exists rather than only once the result comes back.
      const confirmedName = nameCheck?.available ? nameCheck.name : undefined;
      const r = await api.post<RequestView>('/api/send/phone', { phone: to, amountCents: cents, category: kind || undefined, remarks: remarks || undefined, contactId: contactId ?? undefined, businessId: businessId || undefined, recipientName: confirmedName, confirmDuplicate: confirmDuplicate || undefined, ...confirm });
      setRequest(r); setConfirm(false); setDuplicate(null); setConfirmDuplicate(false); setStep('result');
      const resultCopy = copy.send.phone.result as Record<string, string>;
      toast.show(r.status === 'completed' ? 'success' : r.status === 'failed' ? 'error' : 'info', resultCopy[r.status] ?? r.status);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'duplicate_recent') { setConfirm(false); setDuplicate({ at: (e.details as { at: string }).at }); }
      else setDialogError(e instanceof ApiError ? e : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };

  const reset = () => { setRound((n) => n + 1); setStep('form'); setTo(''); setCents(null); setRemarks(''); setContactId(null); setRequest(null); setDuplicate(null); setConfirmDuplicate(false); setErr(null); };
  // An earlier request carries no contact id, so sending it again is an unlinked send.
  const again = () => { if (request) { setTo(request.recipient.value ?? ''); setCents(request.amountCents); if (request.category) setKind(request.category); setRemarks(request.remarks ?? ''); setContactId(null); setConfirmDuplicate(true); setRequest(null); setStep('review'); } };

  const pickedContact = contacts?.find((c) => c.id === contactId) ?? null;
  const utilityAfter = balance?.utilityCents != null && cents !== null ? balance.utilityCents - cents : null;
  const short = utilityAfter !== null && utilityAfter < 0;
  const overCap = cap !== null && cents !== null && cents > cap;
  const stale = balance?.queriedAt ? Date.now() - new Date(balance.queriedAt).getTime() > STALE_MS : false;

  const kinds = categories.map((c) => ({ value: c.name, label: c.name }));
  return (
    <>
      <PageHeader title={copy.send.phone.title} safaricom={copy.send.phone.safaricom} />
      {step === 'form' && (
        <>
          {againUnavailable && <Flash tone="neutral" role="alert" className="mb-4 max-w-xl">{copy.send.phone.againUnavailable}</Flash>}
          <Questionnaire key={round} intro={copy.send.phoneIntro} doneLabel={copy.send.phone.next} onDone={() => { if (valid) setStep('review'); }} steps={[
            ...(businesses.length > 1 ? [{
              key: 'business', question: copy.send.phone.business, valid: !!businessId,
              render: () => (
                <select aria-label={copy.send.phone.business} className="min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink" value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
                  {businesses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
                </select>
              ),
            }] : []),
            { key: 'phone', question: copy.send.phone.recipient, valid: !!normalised, render: () => (
              <div className="space-y-3">
                {(contacts?.length ?? 0) > 0 && (
                  <div>
                    <label htmlFor="send-contact" className="mb-1 block text-base font-semibold">{copy.send.phone.fromContacts.label}</label>
                    <select
                      id="send-contact" aria-label={copy.send.phone.fromContacts.label}
                      className="min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink"
                      value={contactId ?? ''}
                      onChange={(e) => { const picked = contacts?.find((c) => c.id === e.target.value) ?? null; setContactId(picked?.id ?? null); if (picked) setTo(picked.phone ?? ''); }}
                    >
                      <option value="">{copy.send.phone.fromContacts.pick}</option>
                      {(contacts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {phone(c.phone)}</option>)}
                    </select>
                  </div>
                )}
                {contacts?.length === 0 && <p className="text-sm"><Link to="/contacts">{copy.send.phone.fromContacts.manage}</Link></p>}
                {/* Typing a number is the operator's own choice: the saved id no longer applies. */}
                <PhoneInput label={copy.send.phone.recipient} labelHidden value={to} onChange={(v) => { setTo(v); setContactId(null); }} autoFocus />
              </div>
            ) },
            { key: 'amount', question: copy.send.phone.amount, valid: cents !== null && cents % 100 === 0, render: () => <MoneyInput label={copy.send.phone.amount} labelHidden valueCents={cents} onChange={setCents} wholeShillings autoFocus /> },
            { key: 'kind', question: copy.send.phone.kind, valid: categories.length === 0 || !!kind, render: () => (
              <div>
                {kinds.length <= 4
                  ? <Segmented name="category" label={copy.send.phone.kind} value={kind} options={kinds} onChange={setKind} />
                  : <select aria-label={copy.send.phone.kind} className="min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink" value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>}
                {person?.is_owner && <p className="mt-2 text-sm"><Link to="/settings#categories">{copy.send.phone.kindManage}</Link></p>}
              </div>
            ) },
            { key: 'note', question: copy.send.phone.remarks, optional: true, valid: true, empty: !remarks, render: () => <TextField label={copy.send.phone.remarks} labelHidden value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={100} autoFocus /> },
          ]} />
        </>
      )}

      {step === 'review' && (
        <div className="max-w-xl space-y-4">
          <TaskCard
            footerStart={<Button type="button" variant="secondary" onClick={() => { setStep('form'); setConfirmDuplicate(false); setDuplicate(null); }}>{copy.send.phone.back}</Button>}
            footer={<Button type="button" disabled={short || overCap || busy} onClick={() => { setDialogError(null); setConfirm(true); }}>{copy.send.phone.send}</Button>}
          >
            <h2 className="text-xl font-semibold">{copy.send.phone.review.title}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
              <dt className="text-muted">{copy.request.to}</dt>
              <dd>{phone(normalised)}
                {pickedContact && <span className="block text-sm text-muted">{copy.send.phone.fromContacts.saved(pickedContact.name)}</span>}
                <span className="block text-sm text-muted">{nameLine}</span>
              </dd>
              <dt className="text-muted">{copy.request.amount}</dt><dd>{money(cents)}<span className="block text-sm text-muted">{copy.send.phone.review.feeNote}</span></dd>
              <dt className="text-muted">{copy.send.phone.review.chargeLabel}</dt>
              <dd>{charge === undefined ? copy.app.loading : charge === null ? copy.send.phone.review.chargeNone : copy.send.phone.review.charge(money(charge))}</dd>
              <dt className="text-muted">{copy.send.phone.kind}</dt><dd>{kind}</dd>
              {businesses.length > 1 && <><dt className="text-muted">{copy.businesses.title}</dt><dd>{businesses.find((b) => b.id === businessId)?.name ?? '—'}</dd></>}
              <dt className="text-muted">{copy.send.phone.review.balanceNow}</dt>
              <dd>{balance === undefined ? copy.app.loading : balance === null || balance.utilityCents === null ? copy.send.phone.review.balanceMissing : money(balance.utilityCents)}
                {stale && balance?.queriedAt && <span className="block text-sm text-muted">{copy.send.phone.review.balanceStale(when(balance.queriedAt))}</span>}</dd>
              {utilityAfter !== null && <><dt className="text-muted">{copy.send.phone.review.balanceAfter}</dt><dd>{money(utilityAfter)}</dd></>}
            </dl>
            <p className="text-sm text-muted">{copy.send.phone.review.debits}</p>
            {cap !== null && <p className="text-sm text-muted">{copy.send.phone.review.cap(money(cap))}</p>}
            {unknownNumber && <Flash tone="danger" role="alert">{copy.send.phone.review.nameNotFound}</Flash>}
            {short && <Flash tone="danger" role="alert">{copy.send.phone.review.short}</Flash>}
            {duplicate && (
              <Flash tone="neutral" role="alert">
                <p>{copy.send.phone.duplicate(when(duplicate.at))}</p>
                <div className="flex gap-2 pt-1">
                  <Button type="button" onClick={() => { setConfirmDuplicate(true); setDuplicate(null); setConfirm(true); }}>{copy.send.phone.duplicateYes}</Button>
                  <Button type="button" variant="secondary" onClick={() => { setDuplicate(null); setConfirmDuplicate(false); toast.info(copy.send.phone.duplicateCancelled); }}>{copy.send.phone.duplicateNo}</Button>
                </div>
              </Flash>
            )}
            <ErrorCard error={err} />
          </TaskCard>
          <PasswordConfirmDialog open={confirm} title={copy.send.phone.confirmTitle(money(cents), phone(normalised))} busy={busy} error={dialogError} onConfirm={(confirm) => void submit(confirm)} onCancel={() => setConfirm(false)} />
        </div>
      )}

      {step === 'result' && request && (
        <div className="max-w-xl space-y-4">
          <p role="status" className="text-lg font-semibold">{copy.send.phone.result[request.status as 'sent' | 'completed' | 'failed' | 'unknown'] ?? request.status}</p>
          <RequestCard request={request}>
            {request.status === 'completed' && <Button type="button" onClick={reset}>{copy.send.phone.result.sendAnother}</Button>}
            {request.status === 'failed' && <Button type="button" onClick={again}>{request.retriable ? copy.request.tryAgain : copy.request.sendAgain}</Button>}
            {request.status === 'unknown' && <Link className="text-base" to={`/requests/${request.id}`}>{copy.request.markChecked}</Link>}
          </RequestCard>
        </div>
      )}
    </>
  );
}
