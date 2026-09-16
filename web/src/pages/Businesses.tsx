import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BusinessView, CustomerView } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, toastText, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PhoneInput } from '../components/PhoneInput';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { normalizeKe, phone } from '../format';

const CODE = /^[0-9]{3}$/;
/** The code the form offers: the lowest of 000-999 this organisation has not used. */
function nextFreeCode(taken: string[]): string {
  for (let i = 0; i < 1000; i++) { const code = String(i).padStart(3, '0'); if (!taken.includes(code)) return code; }
  return '999';
}

interface BusinessDraft { name: string; code: string }

/** One business: a name, and the three digits every account number starts with. */
function BusinessForm({ existing, offered, error, onSave, onCancel }: { existing: BusinessView | null; offered: string; error: Error | Explained | null; onSave: (draft: BusinessDraft) => Promise<void>; onCancel: () => void }) {
  const c = copy.businesses;
  const [name, setName] = useState(existing?.name ?? '');
  const [code, setCode] = useState(existing?.code ?? offered);
  const codeOk = CODE.test(code.trim());
  return (
    <div className="space-y-3">
      <p className="text-base text-muted">{c.addIntro}</p>
      <TextField label={c.name} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
      {existing ? (
        <p className="text-sm text-muted">{c.code}: <code>{existing.code}</code></p>
      ) : (
        <div className="space-y-1">
          <TextField label={c.code} inputMode="numeric" value={code} maxLength={3} hint={c.codeHint} onChange={(e) => setCode(e.target.value)} />
          <p className="text-sm text-muted">{c.codeNext(offered)}</p>
        </div>
      )}
      <ErrorCard error={error} />
      <div className="flex gap-2">
        <Button type="button" disabled={name.trim().length === 0 || (!existing && !codeOk)} onClick={() => void onSave({ name, code })}>{c.save}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{c.cancel}</Button>
      </div>
    </div>
  );
}

interface CustomerDraft { name: string; phone: string; note: string }

/** One customer under one business. The number is Studio's to give, never typed here. */
function CustomerForm({ existing, error, onSave, onCancel }: { existing: CustomerView | null; error: Error | Explained | null; onSave: (draft: CustomerDraft) => Promise<void>; onCancel: () => void }) {
  const c = copy.businesses;
  const [draft, setDraft] = useState<CustomerDraft>({ name: existing?.name ?? '', phone: existing?.phone ?? '', note: existing?.note ?? '' });
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
 * More than one business on one paybill. A code per business and a minted number per customer make
 * the payer's account number the whole routing rule, so nobody has to guess which business a
 * payment belongs to. One business only means routing is off and nothing is stripped.
 */
export function Businesses() {
  const c = copy.businesses;
  const toast = useToast();
  const { person, permissions, org } = useSession();
  const mayManage = !!person?.is_owner || permissions.includes('businesses.manage');
  const [data, setData] = useState<{ items: BusinessView[]; lastUsedId: string | null } | null>(null);
  const [customers, setCustomers] = useState<Record<string, CustomerView[]>>({});
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [formErr, setFormErr] = useState<Error | Explained | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addingCustomer, setAddingCustomer] = useState<string | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.get<{ items: BusinessView[]; lastUsedId: string | null }>('/api/businesses')); setErr(null); }
    catch (e) { setErr(explainApiError(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadCustomers = useCallback(async (businessId: string) => {
    try {
      const r = await api.get<{ items: CustomerView[] }>('/api/businesses/' + businessId + '/customers');
      setCustomers((m) => ({ ...m, [businessId]: r.items }));
    } catch (e) { toast.error(toastText(e)); }
  }, [toast]);

  const open = (businessId: string) => {
    const next = openId === businessId ? null : businessId;
    setOpenId(next); setAddingCustomer(null); setEditingCustomer(null); setFormErr(null);
    if (next as string | null) void loadCustomers(next as string);
  };

  const saveBusiness = async (draft: BusinessDraft) => {
    setFormErr(null);
    try {
      if (editing) await api.put('/api/businesses/' + editing, { name: draft.name.trim(), active: data?.items.find((b) => b.id === editing)?.active ?? true });
      else await api.post('/api/businesses', { name: draft.name.trim(), code: CODE.test(draft.code.trim()) ? draft.code.trim() : undefined });
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

  const saveCustomer = async (business: BusinessView, draft: CustomerDraft, id?: string) => {
    setFormErr(null);
    const body = { name: draft.name.trim(), phone: normalizeKe(draft.phone) ?? undefined, note: draft.note.trim() || undefined };
    try {
      if (id) await api.put('/api/customers/' + id, body);
      else {
        const made = await api.post<CustomerView>('/api/businesses/' + business.id + '/customers', body);
        toast.success(c.customerAdded(made.name, made.accountNumber));
      }
      setAddingCustomer(null); setEditingCustomer(null);
      await Promise.all([load(), loadCustomers(business.id)]);
    } catch (e) { setFormErr(explainApiError(e)); }
  };

  const retire = async (business: BusinessView, x: CustomerView) => {
    try { await api.del('/api/customers/' + x.id); toast.success(c.retired); await Promise.all([load(), loadCustomers(business.id)]); }
    catch (e) { toast.error(toastText(e)); }
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
                      <span className="text-sm text-muted">{c.customerCount(b.customerCount)}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="secondary" onClick={() => open(b.id)}>{c.customers}</Button>
                      {mayManage && (
                        <>
                          <Button type="button" variant="secondary" onClick={() => { setAdding(false); setFormErr(null); setEditing(b.id); }}>{c.edit}</Button>
                          <Button type="button" variant={b.active ? 'danger' : 'secondary'} onClick={() => void flip(b)}>{b.active ? c.switchOff : c.switchOn}</Button>
                        </>
                      )}
                    </span>
                  </div>

                  {openId === b.id && (
                    <div className="space-y-3 rounded-md border border-line bg-page p-3">
                      {addingCustomer === b.id ? (
                        <CustomerForm existing={null} error={formErr} onSave={(d) => saveCustomer(b, d)} onCancel={() => { setAddingCustomer(null); setFormErr(null); }} />
                      ) : mayManage && <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setEditingCustomer(null); setAddingCustomer(b.id); }}>{c.addCustomer}</Button>}
                      {(customers[b.id] ?? []).length === 0 && addingCustomer !== b.id && <p className="text-sm text-muted">{c.noCustomers}</p>}
                      <ul>
                        {(customers[b.id] ?? []).map((x) => (
                          <li key={x.id} data-testid={'customer-' + x.id} className="border-t border-line py-2 first:border-t-0">
                            {editingCustomer === x.id ? (
                              <CustomerForm existing={x} error={formErr} onSave={(d) => saveCustomer(b, d, x.id)} onCancel={() => { setEditingCustomer(null); setFormErr(null); }} />
                            ) : (
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <span className="flex min-w-0 flex-col">
                                  <span className="text-base">{x.name}</span>
                                  <span className="text-sm text-muted">{c.account}: <code>{x.accountNumber}</code>{x.phone ? ' · ' + phone(x.phone) : ''}</span>
                                  <span className="text-sm text-muted">{c.tellThem(org?.shortcode ?? null, x.accountNumber)}</span>
                                  {x.note && <span className="text-sm text-muted">{x.note}</span>}
                                </span>
                                {mayManage && (
                                  <span className="flex flex-wrap items-center gap-2">
                                    <Button type="button" variant="secondary" onClick={() => { setFormErr(null); setAddingCustomer(null); setEditingCustomer(x.id); }}>{c.editCustomer}</Button>
                                    <Button type="button" variant="danger" onClick={() => void retire(b, x)}>{c.retire}</Button>
                                  </span>
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
          ))}
        </ul>
      </Card>
      {!mayManage && <p className="mt-4 text-sm text-muted">{c.noManage}</p>}
    </>
  );
}
