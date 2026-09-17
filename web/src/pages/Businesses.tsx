import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Confirm } from '../api/types';
import type { AccountView, BusinessView, HistoryEntry } from '../api/types';
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
import { copy } from '../copy/en';
import { normalizeKe, phone } from '../format';

/** The code the form shows as the one Studio will give: the lowest of 000-999 not yet used. */
function nextFreeCode(taken: string[]): string {
  for (let i = 0; i < 1000; i++) { const code = String(i).padStart(3, '0'); if (!taken.includes(code)) return code; }
  return '999';
}

interface BusinessDraft { name: string }

/**
 * One business: a name, and nothing else. The three-digit code every account number starts with is
 * Studio's to give — the next free one, lowest first — so there is no box for it here.
 */
function BusinessForm({ existing, offered, error, onSave, onCancel }: { existing: BusinessView | null; offered: string; error: Error | Explained | null; onSave: (draft: BusinessDraft) => Promise<void>; onCancel: () => void }) {
  const c = copy.businesses;
  const [name, setName] = useState(existing?.name ?? '');
  return (
    <div className="space-y-3">
      <p className="text-base text-muted">{c.addIntro}</p>
      <TextField label={c.name} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
      {existing ? (
        <p className="text-sm text-muted">{c.code}: <code>{existing.code}</code></p>
      ) : (
        <p className="text-sm text-muted">{c.codeNext(offered)}</p>
      )}
      <ErrorCard error={error} />
      <div className="flex gap-2">
        <Button type="button" disabled={name.trim().length === 0} onClick={() => void onSave({ name })}>{c.save}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{c.cancel}</Button>
      </div>
    </div>
  );
}

interface AccountDraft { name: string; phone: string; note: string }

/**
 * One account — a customer, or something under a customer. There is no number box anywhere: Studio
 * draws the number and never lets it be typed, so the only words here are the owner's own.
 */
function AccountForm({ existing, error, onSave, onCancel }: { existing: AccountView | null; error: Error | Explained | null; onSave: (draft: AccountDraft) => Promise<void>; onCancel: () => void }) {
  const c = copy.businesses;
  const [draft, setDraft] = useState<AccountDraft>({ name: existing?.name ?? '', phone: existing?.phone ?? '', note: existing?.note ?? '' });
  const phoneOk = draft.phone.trim().length === 0 || normalizeKe(draft.phone) !== null;
  return (
    <div className="space-y-3">
      <TextField label={c.customerName} value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
      <PhoneInput label={c.customerPhone} value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
      <TextField label={c.customerNote} value={draft.note} maxLength={200} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
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
  const { person, permissions, org } = useSession();
  const mayManage = !!person?.is_owner || permissions.includes('businesses.manage');
  const [data, setData] = useState<{ items: BusinessView[]; lastUsedId: string | null } | null>(null);
  const [accounts, setAccounts] = useState<Record<string, AccountView[]>>({});
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
    try { setData(await api.get<{ items: BusinessView[]; lastUsedId: string | null }>('/api/businesses')); setErr(null); }
    catch (e) { setErr(explainApiError(e)); }
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
      else await api.post('/api/businesses', { name: draft.name.trim() });
      toast.success(c.saved);
      setAdding(false); setEditing(null);
      await load();
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  const flip = async (b: BusinessView) => {
    try {
      await api.put('/api/businesses/' + b.id, { name: b.name, active: !b.active });
      toast.success(b.active ? c.switchedOff : c.switchedOn);
      await load();
    } catch (e) { toast.error(toastText(e)); }
  };

  const body = (draft: AccountDraft) => ({ name: draft.name.trim(), phone: normalizeKe(draft.phone) ?? undefined, note: draft.note.trim() || undefined });

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
          <BusinessForm existing={null} offered={offered} error={formErr} onSave={saveBusiness} onCancel={() => { setAdding(false); setFormErr(null); }} />
        </Card>
      )}
      {data.items.length === 0 && !adding && <p className="mb-4 text-base text-muted">{c.empty}</p>}

      <Card bodyClassName="p-0">
        <ul>
          {data.items.map((b) => (
            <li key={b.id} data-testid={'business-' + b.id} className={cardRow}>
              {editing === b.id ? (
                <BusinessForm existing={b} offered={offered} error={formErr} onSave={saveBusiness} onCancel={() => { setEditing(null); setFormErr(null); }} />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-base font-medium"><code>{b.code}</code> · {b.name}{!b.active && <span className="text-muted"> · {c.off}</span>}</span>
                      <span className="text-sm text-muted">{c.accountCount(b.accountCount)}</span>
                      <span className="text-sm text-muted" data-testid={'numbers-' + b.id}>{c.numbersLine(b.numbers.width, b.numbers.used, b.numbers.capacity)}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="secondary" onClick={() => open(b.id)}>{c.accounts}</Button>
                      {mayManage && (
                        <>
                          <Button type="button" variant="secondary" onClick={() => { setAdding(false); setFormErr(null); setEditing(b.id); }}>{c.edit}</Button>
                          <Button type="button" variant={b.active ? 'danger' : 'secondary'} onClick={() => void flip(b)}>{b.active ? c.switchOff : c.switchOn}</Button>
                          <Button type="button" variant="danger" onClick={() => setDeleting({ id: b.id, name: b.name, businessId: b.id, kind: 'business' })}>{c.retire}</Button>
                        </>
                      )}
                    </span>
                  </div>

                  {openId === b.id && (
                    <div className="space-y-3 rounded-md border border-line bg-page p-3">
                      {addingTo === b.id ? (
                        <AccountForm existing={null} error={formErr} onSave={(d) => saveAccount(b, d)} onCancel={() => { setAddingTo(null); setFormErr(null); }} />
                      ) : mayManage && <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setEditingAccount(null); setAddingTo(b.id); }}>{c.addCustomer}</Button>}
                      {(accounts[b.id] ?? []).length === 0 && addingTo !== b.id && <p className="text-sm text-muted">{c.noCustomers}</p>}
                      <ul>
                        {(accounts[b.id] ?? []).map((x) => (
                          <li key={x.id} data-testid={'account-' + x.id} className="border-t border-line py-2 first:border-t-0">
                            {editingAccount === x.id ? (
                              <AccountForm existing={x} error={formErr} onSave={(d) => editAccount(b, d, x.id)} onCancel={() => { setEditingAccount(null); setFormErr(null); }} />
                            ) : (
                              <div className="space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <span className="flex min-w-0 flex-col">
                                    <span className="text-base">{x.name}</span>
                                    <span className="text-lg" data-testid={'full-' + x.id}><code>{x.fullNumber}</code>{x.phone ? <span className="text-sm text-muted"> · {phone(x.phone)}</span> : null}</span>
                                    <span className="text-sm text-muted">{c.tellThem(org?.shortcode ?? null, x.fullNumber)}</span>
                                    {x.previousHolder && <span className="text-sm text-muted">{c.heldBy(x.previousHolder.name, x.previousHolder.until)}</span>}
                                    {x.note && <span className="text-sm text-muted">{x.note}</span>}
                                  </span>
                                  {mayManage && (
                                    <span className="flex flex-wrap items-center gap-2">
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
                                <div className="space-y-2 rounded-md border border-line p-2">
                                  <p className="text-sm font-medium">{c.accountsUnder(x.name)}</p>
                                  {x.children.length === 0 && addingTo !== x.id && <p className="text-sm text-muted">{c.noAccountsUnder}</p>}
                                  <ul>
                                    {x.children.map((k) => (
                                      <li key={k.id} data-testid={'account-' + k.id} className="py-1">
                                        {editingAccount === k.id ? (
                                          <AccountForm existing={k} error={formErr} onSave={(d) => editAccount(b, d, k.id)} onCancel={() => { setEditingAccount(null); setFormErr(null); }} />
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
                                    <AccountForm existing={null} error={formErr} onSave={(d) => saveUnder(b, x, d)} onCancel={() => { setAddingTo(null); setFormErr(null); }} />
                                  ) : mayManage && <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setEditingAccount(null); setAddingTo(x.id); }}>{c.addAccount}</Button>}
                                </div>
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
          ))}
        </ul>
      </Card>
      {!mayManage && <p className="mt-4 text-sm text-muted">{c.noManage}</p>}
      <PasswordConfirmDialog open={deleting !== null} danger busy={busy}
        title={deleting ? c.deleteTitle(deleting.name) : ''}
        challenge={deleting ? { label: c.typeName(deleting.name), expected: deleting.name } : undefined}
        onConfirm={(confirm) => void confirmDelete(confirm)} onCancel={() => setDeleting(null)} />
    </>
  );
}
