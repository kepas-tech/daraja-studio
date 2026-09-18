import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AccountView, BusinessView } from '../api/types';
import { copy } from '../copy/en';
import { typeOf, wordsOf } from '../businessTypes';

/**
 * Pick a saved account and Studio fills the account reference with its full number. Used by Ask a
 * customer to pay, QR codes and Invoices, so all of them carry the same digits the payer will type.
 * Three levels: a business, a customer, and — when that customer has any — one of the accounts under
 * it. Picking the customer itself is the "no particular account" choice. Reading accounts needs no
 * permission: whoever may ask for money may pick a payer.
 */
export function AccountPicker({ label, onPick }: { label?: string; onPick: (account: AccountView, business: BusinessView) => void }) {
  const c = copy.businesses;
  const [businesses, setBusinesses] = useState<BusinessView[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [q, setQ] = useState('');
  const control = 'min-h-10 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';

  useEffect(() => {
    api.get<{ items: BusinessView[] }>('/api/businesses')
      .then((r) => {
        const live = r.items.filter((b) => b.active);
        setBusinesses(live);
        setBusinessId((id) => id || live[0]?.id || '');
      })
      .catch(() => setBusinesses([]));
  }, []);
  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    setAccounts(null);
    api.get<{ items: AccountView[] }>('/api/businesses/' + businessId + '/accounts' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''))
      .then((r) => { if (alive) setAccounts(r.items); })
      .catch(() => { if (alive) setAccounts([]); });
    return () => { alive = false; };
  }, [businessId, q]);

  if (businesses.length === 0) return null;
  const business = businesses.find((b) => b.id === businessId) ?? businesses[0];
  // Round 3, phase B: the account is whatever this kind of business calls it.
  const words = wordsOf(typeOf(business));
  const pick = 'flex w-full items-baseline justify-between gap-3 rounded px-2 py-1 text-left text-base hover:bg-line/60';
  return (
    <div className="space-y-2 rounded-md border border-line bg-page p-3">
      <p className="text-base font-medium">{label ?? c.pickCustomer(words.one)}</p>
      <p className="text-sm text-muted">{c.pickHint}</p>
      {businesses.length > 1 && (
        <select aria-label={c.title} className={control} value={businessId} onChange={(e) => { setQ(''); setBusinessId(e.target.value); }}>
          {businesses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
        </select>
      )}
      <input type="search" aria-label={c.searchCustomers} placeholder={c.searchCustomers} className={control} value={q} onChange={(e) => setQ(e.target.value)} />
      {accounts === null && <p role="status" className="text-sm text-muted">{copy.app.loading}</p>}
      {accounts?.length === 0 && <p className="text-sm text-muted">{c.noAccounts(words.many)}</p>}
      {accounts && accounts.length > 0 && (
        <ul className="max-h-56 overflow-y-auto">
          {accounts.map((x) => (
            <li key={x.id}>
              <button type="button" className={pick} onClick={() => onPick(x, business)}>
                <span className="min-w-0 truncate">{x.name}</span>
                <code className="text-sm text-muted">{x.fullNumber}</code>
              </button>
              {x.children.length > 0 && (
                <ul className="ml-4 border-l border-line pl-2">
                  {x.children.map((k) => (
                    <li key={k.id}>
                      <button type="button" className={pick} onClick={() => onPick(k, business)}>
                        <span className="min-w-0 truncate">{k.name}</span>
                        <code className="text-sm text-muted">{k.fullNumber}</code>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
