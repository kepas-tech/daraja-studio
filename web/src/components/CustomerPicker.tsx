import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BusinessView, CustomerView } from '../api/types';
import { copy } from '../copy/en';

/**
 * Pick a saved customer and Studio fills the account reference with their account number. Used by
 * Ask a customer to pay, QR codes and Invoices, so all three mint the same six digits the payer
 * will type. Reading customers needs no permission: whoever may ask for money may pick a payer.
 */
export function CustomerPicker({ label, onPick }: { label?: string; onPick: (customer: CustomerView, business: BusinessView) => void }) {
  const c = copy.businesses;
  const [businesses, setBusinesses] = useState<BusinessView[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [customers, setCustomers] = useState<CustomerView[] | null>(null);
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
    setCustomers(null);
    api.get<{ items: CustomerView[] }>('/api/businesses/' + businessId + '/customers' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''))
      .then((r) => { if (alive) setCustomers(r.items); })
      .catch(() => { if (alive) setCustomers([]); });
    return () => { alive = false; };
  }, [businessId, q]);

  if (businesses.length === 0) return null;
  const business = businesses.find((b) => b.id === businessId) ?? businesses[0];
  return (
    <div className="space-y-2 rounded-md border border-line bg-page p-3">
      <p className="text-base font-medium">{label ?? c.pickCustomer}</p>
      <p className="text-sm text-muted">{c.pickHint}</p>
      {businesses.length > 1 && (
        <select aria-label={c.title} className={control} value={businessId} onChange={(e) => { setQ(''); setBusinessId(e.target.value); }}>
          {businesses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
        </select>
      )}
      <input type="search" aria-label={c.searchCustomers} placeholder={c.searchCustomers} className={control} value={q} onChange={(e) => setQ(e.target.value)} />
      {customers === null && <p role="status" className="text-sm text-muted">{copy.app.loading}</p>}
      {customers?.length === 0 && <p className="text-sm text-muted">{c.noCustomers}</p>}
      {customers && customers.length > 0 && (
        <ul className="max-h-56 overflow-y-auto">
          {customers.map((x) => (
            <li key={x.id}>
              <button type="button" className="flex w-full items-baseline justify-between gap-3 rounded px-2 py-1 text-left text-base hover:bg-line/60" onClick={() => onPick(x, business)}>
                <span className="min-w-0 truncate">{x.name}</span>
                <code className="text-sm text-muted">{x.accountNumber}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
