import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { Confirm } from '../api/types';
import type { AccountView, ArrearsView, BusinessTypeView, BusinessView, HistoryEntry, TypeTemplate } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, toastText, type Explained } from '../components/ErrorCard';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PhoneInput } from '../components/PhoneInput';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { BusinessTypeForm } from '../components/BusinessTypeForm';
import { copy } from '../copy/en';
import { MoneyInput } from '../components/MoneyInput';
import { NameChooser } from '../components/NameChooser';
import { money } from '../format';
import { normalizeKe, phone, when } from '../format';
import { expectationLines, wordsOf, type TypeWords } from '../businessTypes';

/** The code the form shows as the one Studio will give: the lowest of 000-999 not yet used. */
function nextFreeCode(taken: string[]): string {
  for (let i = 0; i < 1000; i++) { const code = String(i).padStart(3, '0'); if (!taken.includes(code)) return code; }
  return '999';
}

interface BusinessDraft { name: string; typeKey: string }

/**
 * One business: a name, and nothing else. The three-digit code every account number starts with is
 * Studio's to give — the next free one, lowest first — so there is no box for it here.
 */
function BusinessForm({ existing, offered, types, error, onSave, onCancel }: { existing: BusinessView | null; offered: string; types: BusinessTypeView[]; error: Error | Explained | null; onSave: (draft: BusinessDraft) => Promise<void>; onCancel: () => void }) {
  const c = copy.businesses;
  const [name, setName] = useState(existing?.name ?? '');
  const [typeKey, setTypeKey] = useState(existing?.type.key ?? 'other');
  const control = 'min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  return (
    <div className="space-y-3">
      <p className="text-base text-muted">{c.addIntro}</p>
      <TextField label={c.name} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
      {/* Round 3, phase B: the kind of business is asked for here, because it decides the words
          Studio uses for everything this business holds from now on. */}
      {!existing && (
        <label className="block">
          <span className="mb-1 block text-base font-medium">{c.kindStep}</span>
          <span className="mb-1 block text-sm text-muted">{c.kindStepHint}</span>
          <select aria-label={c.kindStep} className={control} value={typeKey} onChange={(e) => setTypeKey(e.target.value)}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>
        </label>
      )}
      {existing ? (
        <p className="text-sm text-muted">{c.code}: <code>{existing.code}</code></p>
      ) : (
        <p className="text-sm text-muted">{c.codeNext(offered)}</p>
      )}
      <ErrorCard error={error} />
      <div className="flex gap-2">
        <Button type="button" disabled={name.trim().length === 0} onClick={() => void onSave({ name, typeKey })}>{c.save}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{c.cancel}</Button>
      </div>
    </div>
  );
}

interface AccountDraft { name: string; phone: string; note: string; standingCents: number | null }

/**
 * One account — a customer, or something under a customer. There is no number box anywhere: Studio
 * draws the number and never lets it be typed, so the only words here are the owner's own.
 */
function AccountForm({ existing, words, standing, error, onSave, onCancel }: { existing: AccountView | null; words: TypeWords; standing: boolean; error: Error | Explained | null; onSave: (draft: AccountDraft) => Promise<void>; onCancel: () => void }) {
  const c = copy.businesses;
  const [draft, setDraft] = useState<AccountDraft>({ name: existing?.name ?? '', phone: existing?.phone ?? '', note: existing?.note ?? '', standingCents: existing?.standingCents ?? null });
  const phoneOk = draft.phone.trim().length === 0 || normalizeKe(draft.phone) !== null;
  return (
    <div className="space-y-3">
      <TextField label={c.accountName(words.one)} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
      <PhoneInput label={c.customerPhone} value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
      <TextField label={c.customerNote} value={draft.note} maxLength={200} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      {/* Round 3, phase C: what this account is expected to pay each period, when the kind has a
          standing amount. It is a number on the account; nothing charges it. */}
      {standing && (
        <div>
          <MoneyInput label={copy.statement.standing} valueCents={draft.standingCents} onChange={(cents) => setDraft({ ...draft, standingCents: cents })} />
          <p className="mt-1 text-sm text-muted">{copy.statement.standingHint}</p>
        </div>
      )}
      <ErrorCard error={error} />
      <div className="flex gap-2">
        <Button type="button" disabled={draft.name.trim().length === 0 || !phoneOk} onClick={() => void onSave(draft)}>{c.save}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{c.cancel}</Button>
      </div>
    </div>
  );
}

/**
 * More than one business on one paybill. A code per business and a Studio-minted number per account
 * make the payer's account number the whole routing rule, so nobody has to guess which business a
 * payment belongs to. A number carries its own width, and the page says which width is in use.
 */
export function Businesses() {
  const c = copy.businesses;
  const toast = useToast();
  const { person, permissions, org, modules } = useSession();
  // Step one: statements and arrears are a module of their own, so the two doors to them go with it.
  const statementsOn = !modules.off.includes('statements');
  const mayManage = !!person?.is_owner || permissions.includes('businesses.manage');
  const [data, setData] = useState<{ items: BusinessView[]; lastUsedId: string | null } | null>(null);
  const [types, setTypes] = useState<BusinessTypeView[]>([]);
  const [accounts, setAccounts] = useState<Record<string, AccountView[]>>({});
  // Round 3, phase B: the kind of business a row is being changed to, and the kind whose words are
  // being edited ('new' for a kind the owner is adding).
  const [changingKind, setChangingKind] = useState<string | null>(null);
  const [kindDraft, setKindDraft] = useState('');
  const [editingType, setEditingType] = useState<string | 'new' | null>(null);
  // Round 3, phase C: "Who is behind" for one business, loaded when the owner asks for it.
  const [arrears, setArrears] = useState<Record<string, ArrearsView>>({});
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [formErr, setFormErr] = useState<Error | Explained | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // The business a new customer is being added to, or the customer a new account is being added to.
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  // Deleting is the studio's own ceremony: the exact name, then the password. One dialog serves a
  // business, an account and a sub-account.
  const [deleting, setDeleting] = useState<{ id: string; name: string; businessId: string; kind: 'business' | 'account' } | null>(null);
  const [busy, setBusy] = useState(false);
  // "Past holders of this number", fetched only when the owner asks for it.
  const [holders, setHolders] = useState<Record<string, HistoryEntry[]>>({});

  const load = useCallback(async () => {
    try {
      const [list, kinds] = await Promise.all([
        api.get<{ items: BusinessView[]; lastUsedId: string | null }>('/api/businesses'),
        api.get<{ items: BusinessTypeView[] }>('/api/business-types'),
      ]);
      setData(list); setTypes(kinds.items); setErr(null);
    } catch (e) { setErr(explainApiError(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadAccounts = useCallback(async (businessId: string) => {
    try {
      const r = await api.get<{ items: AccountView[] }>('/api/businesses/' + businessId + '/accounts');
      setAccounts((m) => ({ ...m, [businessId]: r.items }));
    } catch (e) { toast.error(toastText(e)); }
  }, [toast]);

  const open = (businessId: string) => {
    const next = openId === businessId ? null : businessId;
    setOpenId(next); setAddingTo(null); setEditingAccount(null); setFormErr(null);
    if (next as string | null) void loadAccounts(next as string);
  };

  const saveBusiness = async (draft: BusinessDraft) => {
    setFormErr(null);
    try {
      if (editing) await api.put('/api/businesses/' + editing, { name: draft.name.trim(), active: data?.items.find((b) => b.id === editing)?.active ?? true });
      else await api.post('/api/businesses', { name: draft.name.trim(), typeKey: draft.typeKey });
      toast.success(c.saved);
      setAdding(false); setEditing(null);
      await load();
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  // Changing the kind changes words: the promise on screen says so, and the server writes one column.
  const changeKind = async (b: BusinessView) => {
    setFormErr(null);
    try {
      await api.put('/api/businesses/' + b.id + '/type', { typeKey: kindDraft });
      toast.success(c.kindChanged(types.find((t) => t.key === kindDraft)?.name ?? kindDraft));
      setChangingKind(null); setKindDraft('');
      await load();
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  const saveType = async (value: { name: string; template: TypeTemplate }) => {
    setFormErr(null);
    try {
      if (editingType === 'new') await api.post('/api/business-types', value);
      else await api.put('/api/business-types/' + editingType, value);
      toast.success(editingType === 'new' ? copy.typeWords.added : copy.typeWords.saved);
      setEditingType(null);
      await load();
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  const removeType = async (t: BusinessTypeView) => {
    setFormErr(null);
    try { await api.del('/api/business-types/' + t.key, {}); toast.success(copy.typeWords.removed); await load(); }
    catch (e) { setFormErr(explainApiError(e)); }
  };

  const flip = async (b: BusinessView) => {
    try {
      await api.put('/api/businesses/' + b.id, { name: b.name, active: !b.active });
      toast.success(b.active ? c.switchedOff : c.switchedOn);
      await load();
    } catch (e) { toast.error(toastText(e)); }
  };

  const body = (draft: AccountDraft) => ({ name: draft.name.trim(), phone: normalizeKe(draft.phone) ?? undefined, note: draft.note.trim() || undefined, standingCents: draft.standingCents ?? undefined });

  const saveAccount = async (business: BusinessView, draft: AccountDraft) => {
    setFormErr(null);
    try {
      const made = await api.post<AccountView>('/api/businesses/' + business.id + '/accounts', body(draft));
      toast.success(c.accountAdded(made.name, made.fullNumber));
      setAddingTo(null);
      await Promise.all([load(), loadAccounts(business.id)]);
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  const saveUnder = async (business: BusinessView, parent: AccountView, draft: AccountDraft) => {
    setFormErr(null);
    try {
      const made = await api.post<AccountView>('/api/accounts/' + parent.id + '/sub-accounts', body(draft));
      toast.success(c.accountAdded(made.name, made.fullNumber));
      setAddingTo(null);
      await Promise.all([load(), loadAccounts(business.id)]);
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  const editAccount = async (business: BusinessView, draft: AccountDraft, id: string) => {
    setFormErr(null);
    try {
      await api.put('/api/accounts/' + id, body(draft));
      toast.success(c.saved);
      setEditingAccount(null);
      await loadAccounts(business.id);
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  /** Delete, once the typed name and the password have both been given. */
  const confirmDelete = async (confirm: Confirm) => {
    if (!deleting) return;
    setBusy(true);
    try {
      if (deleting.kind === 'business') await api.del('/api/businesses/' + deleting.id, { name: deleting.name, ...confirm });
      else await api.del('/api/accounts/' + deleting.id, { name: deleting.name, ...confirm });
      toast.success(c.accountDeleted(deleting.name));
      const businessId = deleting.businessId;
      setDeleting(null);
      await Promise.all([load(), loadAccounts(businessId)]);
    } catch (e) { toast.error(toastText(e)); } finally { setBusy(false); }
  };

  /** Who is behind, in this kind's own words. Read only; nothing here charges anybody. */
  const whoIsBehind = async (b: BusinessView) => {
    if (arrears[b.id]) { setArrears((m) => { const n = { ...m }; delete n[b.id]; return n; }); return; }
    try {
      const r = await api.get<ArrearsView>('/api/businesses/' + b.id + '/arrears');
      setArrears((m) => ({ ...m, [b.id]: r }));
    } catch (e) { toast.error(toastText(e)); }
  };

  const pastHolders = async (x: AccountView) => {
    if (holders[x.id]) { setHolders((m) => { const n = { ...m }; delete n[x.id]; return n; }); return; }
    try {
      const r = await api.get<{ items: HistoryEntry[] }>('/api/accounts/' + x.id + '/history');
      setHolders((m) => ({ ...m, [x.id]: r.items }));
    } catch (e) { toast.error(toastText(e)); }
  };

  if (err && !data) return <><PageHeader title={c.title} /><ErrorCard error={err} /></>;
  if (!data) return <Loading />;
  const offered = nextFreeCode(data.items.map((b) => b.code));

  return (
    <>
      <PageHeader title={c.title}>
        {mayManage && !adding && !editing && <Button onClick={() => { setFormErr(null); setEditing(null); setAdding(true); }}>{c.add}</Button>}
      </PageHeader>
      <p className="mb-4 text-base text-muted">{c.intro}</p>
      {deleting?.kind === 'business' && <p className="mb-4 text-sm text-muted">{c.deleteBusinessBody}</p>}
      <ErrorCard error={err} />
      {data.items.length === 1 && <p className="mb-4 rounded-md border border-line bg-page p-3 text-base">{c.routingOff}</p>}
      {data.items.length > 1 && <p className="mb-4 text-sm text-muted">{c.routingOn}</p>}

      {adding && (
        <Card className="mb-6 max-w-xl" bodyClassName="p-4">
          <BusinessForm existing={null} offered={offered} types={types} error={formErr} onSave={saveBusiness} onCancel={() => { setAdding(false); setFormErr(null); }} />
        </Card>
      )}
      {data.items.length === 0 && !adding && <p className="mb-4 text-base text-muted">{c.empty}</p>}

      <Card bodyClassName="p-0">
        <ul>
          {data.items.map((b) => {
            const words = wordsOf(b.type);
            // Narrowed once here: the level under an account exists only when the kind names one.
            const sub = words.sub;
            return (
            <li key={b.id} data-testid={'business-' + b.id} className={cardRow}>
              {editing === b.id ? (
                <BusinessForm existing={b} offered={offered} types={types} error={formErr} onSave={saveBusiness} onCancel={() => { setEditing(null); setFormErr(null); }} />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-base font-medium"><code>{b.code}</code> · {b.name}{!b.active && <span className="text-muted"> · {c.off}</span>}</span>
                      <span className="text-sm text-muted" data-testid={'kind-' + b.id}>{c.kind(b.type.name)}</span>
                      <span className="text-sm text-muted">{c.accountCount(b.accountCount, words.one, words.many)}</span>
                      <span className="text-sm text-muted" data-testid={'numbers-' + b.id}>{c.numbersLine(b.numbers.width, b.numbers.used, b.numbers.capacity)}</span>
                      {/* Round 3, phase B: what this kind of business expects, in its own words. */}
                      <span className="text-sm text-muted" data-testid={'expects-' + b.id}>{expectationLines(b.type.template).join(' ')}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="secondary" onClick={() => open(b.id)}>{c.accounts(words.many)}</Button>
                      {mayManage && (
                        <>
                          <Button type="button" variant="secondary" onClick={() => { setAdding(false); setFormErr(null); setChangingKind(b.id); setKindDraft(b.type.key); }}>{c.changeKind}</Button>
                          {statementsOn && <Button type="button" variant="secondary" onClick={() => void whoIsBehind(b)}>{copy.statement.who}</Button>}
                          <Button type="button" variant="secondary" onClick={() => { setAdding(false); setFormErr(null); setEditing(b.id); }}>{c.edit}</Button>
                          <Button type="button" variant={b.active ? 'danger' : 'secondary'} onClick={() => void flip(b)}>{b.active ? c.switchOff : c.switchOn}</Button>
                          <Button type="button" variant="danger" onClick={() => setDeleting({ id: b.id, name: b.name, businessId: b.id, kind: 'business' })}>{c.retire}</Button>
                        </>
                      )}
                    </span>
                  </div>

                  {/* Changing the kind sits right here, with what it does and does not touch. */}
                  {changingKind === b.id && (
                    <div className="space-y-2 rounded-md border border-line bg-page p-3">
                      <p className="text-base font-medium">{c.changeKindTitle(b.name)}</p>
                      <p className="text-sm text-muted">{c.changeKindBody}</p>
                      <div className="flex flex-wrap items-end gap-2">
                        <select aria-label={c.changeKind} className="min-h-11 rounded-md border border-line bg-surface px-3 text-base text-ink" value={kindDraft} onChange={(e) => setKindDraft(e.target.value)}>
                          {types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
                        </select>
                        <Button type="button" disabled={kindDraft === b.type.key} onClick={() => void changeKind(b)}>{c.save}</Button>
                        <Button type="button" variant="secondary" onClick={() => { setChangingKind(null); setFormErr(null); }}>{c.cancel}</Button>
                      </div>
                    </div>
                  )}

                  {/* Round 3, phase C: who is behind, for a kind that expects money regularly. */}
                  {arrears[b.id] && (
                    <div className="space-y-2 rounded-md border border-line bg-page p-3" data-testid={'arrears-' + b.id}>
                      <p className="text-base font-medium">{copy.statement.who}</p>
                      {!arrears[b.id]!.hasArrears ? <p className="text-sm text-muted">{copy.statement.noArrearsHere}</p> : (
                        <>
                          <p className="text-sm text-muted">{copy.statement.whoIntro(words.many)}</p>
                          {arrears[b.id]!.rows.length === 0 ? <p className="text-sm text-muted">{copy.statement.whoNone}</p> : (
                            <>
                              <p className="text-base">{copy.statement.whoTotal(money(arrears[b.id]!.owedCents), arrears[b.id]!.behindCount)}</p>
                              <ul>
                                {arrears[b.id]!.rows.map((x) => (
                                  <li key={x.accountId} className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2 text-base" data-testid={'arrears-row-' + x.accountId}>
                                    <span className="min-w-0">
                                      <Link to={'/accounts/' + x.accountId}>{x.name}</Link>
                                      <span className="block text-sm text-muted">
                                        {x.owedCents > 0 ? copy.statement.behind(x.behindPeriods) : copy.statement.upToDate}
                                        {x.oldestInvoice ? ' · ' + copy.statement.oldest(x.oldestInvoice.reference, x.oldestInvoice.billedPeriod) : ''}
                                        {x.lastRemindedAt ? ' · ' + copy.statement.lastReminded(when(x.lastRemindedAt)) : ''}
                                      </span>
                                    </span>
                                    <span className="whitespace-nowrap">{money(x.owedCents)}</span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {openId === b.id && (
                    <div className="space-y-3 rounded-md border border-line bg-page p-3">
                      {addingTo === b.id ? (
                        <AccountForm existing={null} words={words} standing={b.type.template.standingAmount === 'fixed'} error={formErr} onSave={(d) => saveAccount(b, d)} onCancel={() => { setAddingTo(null); setFormErr(null); }} />
                      ) : mayManage && <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setEditingAccount(null); setAddingTo(b.id); }}>{c.addAccount(words.a)}</Button>}
                      {(accounts[b.id] ?? []).length === 0 && addingTo !== b.id && <p className="text-sm text-muted">{c.noAccounts(words.many)}</p>}
                      <ul>
                        {(accounts[b.id] ?? []).map((x) => (
                          <li key={x.id} data-testid={'account-' + x.id} className="border-t border-line py-2 first:border-t-0">
                            {editingAccount === x.id ? (
                              <AccountForm existing={x} words={words} standing={b.type.template.standingAmount === 'fixed'} error={formErr} onSave={(d) => editAccount(b, d, x.id)} onCancel={() => { setEditingAccount(null); setFormErr(null); }} />
                            ) : (
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <span className="flex min-w-0 flex-col">
                                    <span className="text-base">{x.name}</span>
                                    <span className="text-lg" data-testid={'full-' + x.id}><code>{x.fullNumber}</code>{x.phone ? <span className="text-sm text-muted"> · {phone(x.phone)}</span> : null}</span>
                                    <span className="text-sm text-muted">{c.tellThem(org?.shortcode ?? null, x.fullNumber)}</span>
                                    {mayManage ? <NameChooser accountId={x.id} current={x.namedNumber ?? null} onChanged={() => void loadAccounts(b.id)} />
                                      : x.namedNumber ? <span className="text-sm">{copy.namedNumber.current(x.namedNumber)}</span> : null}
                                    {x.previousHolder && <span className="text-sm text-muted">{c.heldBy(x.previousHolder.name, x.previousHolder.until)}</span>}
                                    {x.note && <span className="text-sm text-muted">{x.note}</span>}
                                  </span>
                                  {mayManage && (
                                    <span className="flex flex-wrap items-center gap-2">
                                      {statementsOn && <Link className="inline-flex min-h-11 items-center rounded-md border border-line bg-page px-4 font-semibold text-ink hover:no-underline" to={'/accounts/' + x.id}>{copy.statement.open}</Link>}
                                      <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setAddingTo(null); setEditingAccount(x.id); }}>{c.editAccount}</Button>
                                      <Button type="button" variant="secondary" onClick={() => void pastHolders(x)}>{c.pastHolders}</Button>
                                      <Button type="button" variant="danger" onClick={() => setDeleting({ id: x.id, name: x.name, businessId: b.id, kind: 'account' })}>{c.retire}</Button>
                                    </span>
                                  )}
                                </div>

                                {holders[x.id] && (
                                  <div className="rounded-md border border-line p-2 text-sm">
                                    <p className="font-medium">{c.pastHolders}</p>
                                    {holders[x.id]!.length === 0 && <p className="text-muted">{c.pastHoldersNone}</p>}
                                    <ul>{holders[x.id]!.map((h, i) => <li key={i} className="text-muted">{h.name} · {c.wasHeldBy(h.name, h.deletedAt.slice(0, 10))}</li>)}</ul>
                                  </div>
                                )}
                                {/* The level under an account exists only when this kind of business has one. */}
                                {sub && (
                                <div className="space-y-2 rounded-md border border-line p-2">
                                  <p className="text-sm font-medium">{c.accountsUnder(x.name, words.subs ?? sub)}</p>
                                  {x.children.length === 0 && addingTo !== x.id && <p className="text-sm text-muted">{c.noUnder(words.subs ?? sub)}</p>}
                                  <ul>
                                    {x.children.map((k) => (
                                      <li key={k.id} data-testid={'account-' + k.id} className="py-1">
                                        {editingAccount === k.id ? (
                                          <AccountForm existing={k} words={{ ...words, one: sub, a: 'a ' + sub.toLowerCase(), many: words.subs ?? sub }} standing={false} error={formErr} onSave={(d) => editAccount(b, d, k.id)} onCancel={() => { setEditingAccount(null); setFormErr(null); }} />
                                        ) : (
                                          <div className="flex flex-wrap items-center justify-between gap-3">
                                            <span className="text-base"><code>{k.fullNumber}</code> · {k.name}{k.note ? <span className="text-sm text-muted"> · {k.note}</span> : null}</span>
                                            {mayManage && (
                                              <span className="flex flex-wrap items-center gap-2">
                                                <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setEditingAccount(k.id); }}>{c.editAccount}</Button>
                                                <Button type="button" variant="danger" onClick={() => setDeleting({ id: k.id, name: k.name, businessId: b.id, kind: 'account' })}>{c.retire}</Button>
                                              </span>
                                            )}
                                          </div>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                  {addingTo === x.id ? (
                                    <AccountForm existing={null} words={{ ...words, one: sub, a: 'a ' + sub.toLowerCase(), many: words.subs ?? sub }} standing={false} error={formErr} onSave={(d) => saveUnder(b, x, d)} onCancel={() => { setAddingTo(null); setFormErr(null); }} />
                                  ) : mayManage && <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setEditingAccount(null); setAddingTo(x.id); }}>{c.addSub('a ' + sub.toLowerCase())}</Button>}
                                </div>
                                )}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
            );
          })}
        </ul>
      </Card>

      {/* Round 3, phase B: the kinds themselves. Data the owner edits, not code. */}
      {mayManage && (
        <Card className="mt-6" title={c.kindsTitle} bodyClassName="space-y-3 p-4">
          <p className="text-sm text-muted">{c.kindsIntro}</p>
          <ErrorCard error={formErr} />
          <ul className="space-y-2">
            {types.map((t) => (
              <li key={t.key} data-testid={'type-' + t.key} className="rounded-md border border-line p-3">
                {editingType === t.key ? (
                  <BusinessTypeForm existing={t} error={null} onSave={saveType} onCancel={() => { setEditingType(null); setFormErr(null); }} />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-base font-medium">{t.name}</span>
                      <span className="text-sm text-muted">{copy.businesses.accountCount(0, t.template.accountNoun, wordsOf(t).many).replace(/^0 /, '')} · {expectationLines(t.template).join(' ')}</span>
                      <span className="text-sm text-muted">{t.template.statementNoun}{t.template.categories.length > 0 ? ' · ' + t.template.categories.join(', ') : ''}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setEditingType(t.key); }}>{copy.typeWords.edit}</Button>
                      <Button type="button" variant="danger" onClick={() => void removeType(t)}>{copy.typeWords.remove}</Button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {editingType === 'new' ? (
            <BusinessTypeForm existing={null} error={null} onSave={saveType} onCancel={() => { setEditingType(null); setFormErr(null); }} />
          ) : (
            <Button type="button" onClick={() => { setFormErr(null); setEditingType('new'); }}>{copy.typeWords.add}</Button>
          )}
        </Card>
      )}
      {!mayManage && <p className="mt-4 text-sm text-muted">{c.noManage}</p>}
      <PasswordConfirmDialog open={deleting !== null} danger busy={busy}
        title={deleting ? c.deleteTitle(deleting.name) : ''}
        challenge={deleting ? { label: c.typeName(deleting.name), expected: deleting.name } : undefined}
        onConfirm={(confirm) => void confirmDelete(confirm)} onCancel={() => setDeleting(null)} />
    </>
  );
}
