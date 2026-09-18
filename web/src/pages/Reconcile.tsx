import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { PageHeader } from '../components/PageHeader';
import { Segmented } from '../components/Segmented';
import { copy } from '../copy/en';
import { money, when } from '../format';

/** One float account's figures between two of Safaricom's balance readings. */
interface Reading { workingCents: number | null; utilityCents: number | null; at: string }
export interface ReconcileView {
  window: { days: number; from: string; to: string };
  safaricom: { records: number; totalCents: number };
  studio: { records: number; totalCents: number };
  missing: { receipt: string; amountCents: number; at: string | null; phone: string | null; accountReference: string | null }[];
  extra: { id: string; type: string; receipt: string | null; amountCents: number; at: string; accountReference: string | null }[];
  balance: {
    latest: Reading | null; previous: Reading | null;
    movement: {
      inCents: number; outCents: number; chargeCents: number; paymentsIn: number; paymentsOut: number;
      workingChangeCents: number | null; utilityChangeCents: number | null;
      expectedChangeCents: number | null; actualChangeCents: number | null; differenceCents: number | null;
    };
  };
  checkedAt: string;
}

const WINDOWS = ['7', '30', '90'] as const;

/**
 * Round 3, phase D-1: check nothing is missing.
 *
 * One press asks Safaricom for its own record of the window and compares it with Studio's rows: what
 * Safaricom shows and Studio does not have, what Studio has and the pull did not return, and the two
 * balances Safaricom reported against the money that moved between them. Nothing is written, and
 * nothing found here is recorded by this page.
 */
export function Reconcile() {
  const c = copy.reconcile;
  const [days, setDays] = useState<string>('7');
  const [v, setV] = useState<ReconcileView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | Explained | null>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try { setV(await api.post<ReconcileView>('/api/reconcile', { days: Number(days) })); }
    catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };
  const tone = (difference: number | null) => (difference === null ? 'text-muted' : difference === 0 ? 'text-ink' : 'text-danger');

  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom} />
      <p className="mb-4 text-base text-muted">{c.intro}</p>
      <Card className="mb-6" bodyClassName="flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-56 flex-1">
          <Segmented name="reconcile-window" label={c.window} value={days} options={WINDOWS.map((w) => ({ value: w, label: c.windows[w]! }))} onChange={setDays} />
        </div>
        <Button type="button" disabled={busy} onClick={() => void run()}>{busy ? c.checking : c.check}</Button>
      </Card>
      <ErrorCard error={err} />
      {v && (
        <div className="space-y-4">
          <p className="text-sm text-muted" data-testid="reconcile-checked">{c.checkedAt(when(v.checkedAt))}</p>
          <Card title={c.missingTitle} bodyClassName="p-0">
            <div className="flex flex-wrap gap-4 border-b border-line bg-page px-4 py-3 text-base">
              <span data-testid="safaricom-says">{c.safaricomSays(v.safaricom.records, money(v.safaricom.totalCents))}</span>
              <span data-testid="studio-has">{c.studioHas(v.studio.records, money(v.studio.totalCents))}</span>
            </div>
            {v.missing.length === 0 ? <p className="p-4 text-base text-muted">{c.missingNone}</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-base">
                  <thead><tr className="text-left text-sm text-muted">{Object.values(c.columns).map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
                  <tbody>{v.missing.map((m) => (
                    <tr key={m.receipt} className="border-t border-line" data-testid={'missing-' + m.receipt}>
                      <td className="px-4 py-3"><code className="text-sm">{m.receipt}</code></td>
                      <td className="px-4 py-3 whitespace-nowrap">{m.at ? when(m.at) : '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{money(m.amountCents)}</td>
                      <td className="px-4 py-3">{m.phone ?? '—'}</td>
                      <td className="px-4 py-3">{m.accountReference ?? '—'}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
            <p className="border-t border-line px-4 py-2 text-sm text-muted">{c.missingHint}</p>
          </Card>

          <Card title={c.extraTitle} bodyClassName="p-0">
            {v.extra.length === 0 ? <p className="p-4 text-base text-muted">{c.extraNone}</p> : (
              <ul>{v.extra.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-base first:border-t-0" data-testid={'extra-' + (x.receipt ?? x.id)}>
                  <span className="min-w-0"><Link to={'/requests/' + x.id}><code className="text-sm">{x.receipt ?? x.type}</code></Link><span className="block text-sm text-muted">{when(x.at)}{x.accountReference ? ' · ' + x.accountReference : ''}</span></span>
                  <span className="whitespace-nowrap">{money(x.amountCents)}</span>
                </li>))}</ul>
            )}
            <p className="border-t border-line px-4 py-2 text-sm text-muted">{c.extraHint}</p>
          </Card>

          <Card title={c.balanceTitle} bodyClassName="space-y-2 p-4">
            {!v.balance.latest ? <p className="text-base text-muted">{c.balanceNone}</p>
              : !v.balance.previous ? <p className="text-base text-muted">{c.balanceOne}</p>
              : (
                <>
                  <p className="text-sm text-muted" data-testid="balance-readings">
                    {c.reading(when(v.balance.previous.at), money(v.balance.previous.workingCents), money(v.balance.previous.utilityCents))}<br />
                    {c.reading(when(v.balance.latest.at), money(v.balance.latest.workingCents), money(v.balance.latest.utilityCents))}
                  </p>
                  <p className="text-base" data-testid="balance-movement">{c.movement(money(v.balance.movement.inCents), money(v.balance.movement.outCents), money(v.balance.movement.chargeCents), v.balance.movement.paymentsIn)}</p>
                  <p className="text-sm text-muted" data-testid="balance-change">{c.perAccount(money(v.balance.movement.workingChangeCents), money(v.balance.movement.utilityChangeCents))}</p>
                  {/* Studio does not assume which float account Safaricom credits, so the two are
                      compared together, and a difference is stated rather than hidden. */}
                  <p className={tone(v.balance.movement.differenceCents)} data-testid="balance-agrees">
                    {c.movementTotal(money(v.balance.movement.expectedChangeCents), money(v.balance.movement.actualChangeCents))}{' '}
                    {v.balance.movement.differenceCents === 0 ? c.agrees : c.differs(money(Math.abs(v.balance.movement.differenceCents ?? 0)))}
                  </p>
                </>
              )}
          </Card>
        </div>
      )}
    </>
  );
}
