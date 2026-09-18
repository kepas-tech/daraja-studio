import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { DeliveryView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { Segmented } from '../components/Segmented';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { when } from '../format';

type Filter = 'all' | 'pending' | 'delivered' | 'failed';
const FILTERS: Filter[] = ['all', 'pending', 'delivered', 'failed'];

/**
 * Round 3, phase E: what Studio sent to the webhook address, and what came back.
 *
 * The table is the answer to one question a developer asks when a receiver goes quiet: did Studio
 * try, what did my address say, and when is the next attempt. A delivery that has run out of
 * attempts can be put back in the queue by hand from here.
 */
export function Deliveries() {
  const c = copy.deliveries;
  const toast = useToast();
  const [state, setState] = useState<Filter>('all');
  const [items, setItems] = useState<DeliveryView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);

  const load = useCallback(() => api.get<{ items: DeliveryView[] }>(`/api/webhooks/deliveries?state=${state}&limit=50`)
    .then((r) => setItems(r.items))
    .catch((e) => { setItems([]); setErr(explainApiError(e)); }), [state]);
  useEffect(() => { void load(); }, [load]);

  const retry = async (id: string) => {
    setBusy(id); setErr(null);
    try { await api.post(`/api/webhooks/deliveries/${id}/retry`); toast.success(c.retried); await load(); }
    catch (e) { setErr(explainApiError(e)); } finally { setBusy(null); }
  };

  const cell = 'px-4 py-3 align-top';
  const th = 'px-4 py-2 text-left font-medium';
  return (
    <>
      <PageHeader title={c.title} />
      <div className="space-y-6">
        <p className="max-w-2xl text-base text-muted">{c.intro}</p>
        <div className="max-w-xl">
          <Segmented name="delivery-state" label={c.filter} value={state} options={FILTERS.map((f) => ({ value: f, label: c.states[f]! }))} onChange={setState} />
        </div>
        {err && <ErrorCard error={err} />}
        <Card bodyClassName="p-0">
          {items === null ? <Loading /> : items.length === 0 ? (
            <p className="p-4 text-base text-muted">{c.empty[state]}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead><tr className="border-b border-line text-sm text-muted">
                  <th className={th}>{c.columns.when}</th>
                  <th className={th}>{c.columns.event}</th>
                  <th className={th}>{c.columns.attempts}</th>
                  <th className={th}>{c.columns.status}</th>
                  <th className={th}>{c.columns.said}</th>
                  <th className={th}>{c.columns.next}</th>
                  <th className={th}></th>
                </tr></thead>
                <tbody>
                  {items.map((d) => (
                    <tr key={d.id} data-testid={'delivery-' + d.id} className="border-b border-line last:border-b-0">
                      <td className={`${cell} whitespace-nowrap`}>{when(d.createdAt)}</td>
                      <td className={cell}>
                        <code className="text-sm">{d.event}</code>
                        {d.requestId && <span className="block"><Link to={'/requests/' + d.requestId}>{copy.notifications.openPayment}</Link></span>}
                      </td>
                      <td className={`${cell} whitespace-nowrap`}>{d.attempts}</td>
                      <td className={`${cell} whitespace-nowrap`}>{d.lastStatus ?? '—'}</td>
                      <td className={`${cell} max-w-xs break-words text-sm text-muted`}>{d.lastResponse ?? '—'}</td>
                      <td className={`${cell} whitespace-nowrap`}>{
                        d.deliveredAt ? c.deliveredAt(when(d.deliveredAt))
                          : d.nextRetryAt ? c.nextAt(when(d.nextRetryAt))
                          : <span className="text-danger">{c.gaveUp}</span>
                      }</td>
                      <td className={`${cell} whitespace-nowrap`}>
                        {!d.deliveredAt && <Button type="button" variant="secondary" disabled={busy === d.id} onClick={() => void retry(d.id)}>{c.retry}</Button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <p className="text-base"><Link to="/webhooks">{c.backToWebhooks}</Link></p>
      </div>
    </>
  );
}
