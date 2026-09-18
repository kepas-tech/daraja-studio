import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../api/client';
import type { StatementView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, when } from '../format';

/**
 * Round 3, phase C: one account's running statement.
 *
 * Every line is a row that exists — a payment in, a payout out, an invoice raised — oldest first,
 * with one plain line on top: paid to date, and still owed. Nothing on this page moves money on its
 * own: raising the next invoice and writing a reminder are both one press, and both are recorded.
 */
export function AccountStatement() {
  const { id = '' } = useParams();
  const c = copy.statement;
  const toast = useToast();
  const [v, setV] = useState<StatementView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [busy, setBusy] = useState(false);
  const [reminder, setReminder] = useState<{ message: string; phone: string | null } | null>(null);

  const load = useCallback(() => api.get<StatementView>(`/api/accounts/${id}/statement`)
    .then((r) => { setV(r); setErr(null); })
    .catch((e) => setErr(explainApiError(e))), [id]);
  useEffect(() => { void load(); }, [load]);

  const raise = async () => {
    setBusy(true); setErr(null);
    try {
      const made = await api.post<{ reference: string }>(`/api/accounts/${id}/next-invoice`, {});
      toast.success(c.raised(made.reference));
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };
  const remind = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ message: string; phone: string | null }>(`/api/accounts/${id}/remind`, {});
      setReminder(r); toast.success(c.reminded);
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  if (err && !v) return <><PageHeader title={copy.request.notFoundTitle} /><ErrorCard error={err} /></>;
  if (!v) return <Loading />;
  const t = v.type.template;
  const regular = t.regular !== 'no';
  const scheduled = regular && t.standingAmount === 'fixed';
  const kindWord = (k: 'in' | 'out' | 'invoice') => (k === 'in' ? c.in : k === 'out' ? c.out : c.invoice);
  return (
    <>
      <PageHeader title={v.account.name} />
      <p className="mb-4 text-base text-muted">{c.subtitle(t.statementNoun, v.account.fullNumber, v.account.businessName)}</p>
      <ErrorCard error={err} />

      {/* The one plain line on top. */}
      <div data-testid="statement-line" className="mb-4 rounded-md border border-line bg-surface px-4 py-3 text-lg">
        {c.line(money(v.paidInCents), money(v.owedCents))}
      </div>

      {scheduled && (
        <Card className="mb-4" title={c.expectTitle} bodyClassName="space-y-2 p-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="text-muted">{c.standing}</dt>
            <dd>{v.standingCents === null ? '—' : money(v.standingCents)}</dd>
            <dt className="text-muted">{copy.typeWords.regularLine[t.regular] ?? ''}</dt>
            <dd>{v.schedule.expectedCents === null ? '—' : c.expected(money(v.standingCents ?? 0), v.schedule.periodsDue)}</dd>
            <dt className="text-muted">{c.owed}</dt>
            <dd data-testid="statement-behind">{v.owedCents > 0 ? c.behind(v.behindPeriods) : c.upToDate}</dd>
            <dt className="text-muted">{c.remindedLabel}</dt>
            <dd>{v.lastRemindedAt ? when(v.lastRemindedAt) : c.neverReminded}</dd>
          </dl>
          {v.standingCents === null && <p className="text-sm text-muted" data-testid="no-standing">{c.noStanding} <Link to="/businesses">{c.setStanding}</Link></p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" disabled={busy || v.standingCents === null} onClick={() => void raise()}>{c.raise}</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void remind()}>{c.remind}</Button>
          </div>
          {reminder && (
            <div data-testid="reminder" className="space-y-2 rounded-md border border-line bg-page p-3">
              <p className="text-base font-medium">{c.reminderTitle}</p>
              <p className="text-base">{reminder.message}</p>
              <p className="text-sm text-muted">{c.reminderHint}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(reminder.message); toast.success(c.copied); }}>{c.copyMessage}</Button>
                {reminder.phone && <a className="inline-flex min-h-11 items-center rounded-md border border-line bg-page px-4 font-semibold text-ink hover:no-underline" href={`sms:${reminder.phone}?body=${encodeURIComponent(reminder.message)}`}>{c.sendByPhone}</a>}
              </div>
            </div>
          )}
        </Card>
      )}

      <Card bodyClassName="p-0">
        {v.rows.length === 0 ? <p className="p-4 text-base text-muted">{c.empty}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead><tr className="text-left text-sm text-muted">
                {Object.values(c.columns).map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
                <th className="px-4 py-2 font-medium">{copy.request.category}</th>
              </tr></thead>
              <tbody>{v.rows.map((r, i) => (
                <tr key={`${r.kind}-${r.requestId ?? r.invoiceId ?? i}`} className="border-t border-line" data-testid={'row-' + (r.requestId ?? r.invoiceId ?? i)}>
                  <td className="px-4 py-3 whitespace-nowrap">{when(r.at)}</td>
                  <td className="px-4 py-3"><Link to={r.kind === 'invoice' ? `/invoices/${r.invoiceId}` : `/requests/${r.requestId}`}>{kindWord(r.kind)}</Link>{r.accountName && <span className="block text-sm text-muted">{r.accountName}</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{money(r.amountCents)}</td>
                  <td className="px-4 py-3"><StatusPill kind={r.kind === 'invoice' ? (r.status === 'paid' ? 'ok' : r.status === 'cancelled' ? 'muted' : 'warn') : r.kind === 'in' ? 'ok' : 'warn'}>{r.status}</StatusPill></td>
                  <td className="px-4 py-3"><code className="text-sm">{r.receipt ?? r.reference ?? '—'}</code></td>
                  <td className="px-4 py-3 text-sm text-muted">{r.label}</td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {!scheduled && (
        <p className="mt-4 text-sm text-muted" data-testid="no-arrears">{regular ? copy.statement.noStanding : copy.statement.noArrearsHere}</p>
      )}
      <p className="mt-4 text-sm text-muted"><Link to="/businesses">{copy.businesses.title}</Link></p>
      <Flash tone="neutral" className="mt-4">{copy.statement.standingHint}</Flash>
    </>
  );
}
