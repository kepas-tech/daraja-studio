import { copy } from '../copy/en';
import { money } from '../format';
import type { ReportDay, ReportTotals } from '../api/types';

/**
 * Round 3, phase D-7: the three pictures of the window Reports already carries as tables. Each one
 * is drawn from the same read the table under it uses, so a chart can never tell a different story
 * from the numbers beside it. No chart library: bars of brand and danger tint, sized in percentages,
 * and every chart carries a sentence for anybody who cannot see it.
 */

/** A bar's height as a share of the tallest in the window. A value that is not zero keeps a sliver. */
const share = (value: number, max: number) => (max <= 0 ? 0 : value <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100)));

export function DayChart({ days, label }: { days: ReportDay[]; label: (iso: string) => string }) {
  const max = days.reduce((m, d) => Math.max(m, d.inCents, d.outCents), 0);
  const total = days.reduce((t, d) => ({ inCents: t.inCents + d.inCents, outCents: t.outCents + d.outCents }), { inCents: 0, outCents: 0 });
  return (
    <div data-testid="chart-days" role="img" aria-label={copy.reports.charts.daysLabel(days.length, money(total.inCents), money(total.outCents))}>
      <div className="flex items-center gap-3 text-sm">
        <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-sm bg-brand" />{copy.reports.in}</span>
        <span className="flex items-center gap-1"><span className="inline-block size-3 rounded-sm bg-brand-dark" />{copy.reports.out}</span>
        <span className="ml-auto text-muted">{copy.reports.charts.peak(money(max))}</span>
      </div>
      <div className="mt-2 flex h-28 items-end gap-1 overflow-x-auto">
        {days.map((d) => (
          <div key={d.day} className="flex h-full min-w-1.5 flex-1 items-end justify-center gap-px" title={`${label(d.day)} · ${money(d.inCents)} ${copy.reports.in.toLowerCase()} · ${money(d.outCents)} ${copy.reports.out.toLowerCase()}`}>
            <span data-testid={'bar-in-' + d.day} className="w-1/2 rounded-t-sm bg-brand" style={{ height: share(d.inCents, max) + '%' }} />
            <span data-testid={'bar-out-' + d.day} className="w-1/2 rounded-t-sm bg-brand-dark" style={{ height: share(d.outCents, max) + '%' }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-sm text-muted">
        <span>{days.length > 0 ? label(days[0]!.day) : ''}</span>
        <span>{days.length > 1 ? label(days[days.length - 1]!.day) : ''}</span>
      </div>
    </div>
  );
}

/** What happened to the payments in the window: paid, failed, or still waiting on an answer. */
export function StatusChart({ totals }: { totals: ReportTotals }) {
  const finished = totals.completed + totals.failed + totals.unknown;
  const max = Math.max(totals.completed, totals.failed, totals.unknown, 0);
  const rows = [
    { key: 'completed', label: copy.reports.charts.paid, n: totals.completed, bar: 'bg-brand' },
    { key: 'failed', label: copy.reports.charts.failed, n: totals.failed, bar: 'bg-danger' },
    { key: 'unknown', label: copy.reports.charts.unknown, n: totals.unknown, bar: 'bg-muted' },
  ];
  return (
    <div data-testid="chart-status" role="img" aria-label={copy.reports.charts.statusLabel(finished)} className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 text-muted">{r.label}</span>
          <span className="h-4 min-w-0 flex-1 rounded-sm bg-page">
            <span data-testid={'status-bar-' + r.key} className={'block h-4 rounded-sm ' + r.bar} style={{ width: share(r.n, max) + '%' }} />
          </span>
          <span className="w-8 text-right font-semibold">{r.n}</span>
        </div>
      ))}
    </div>
  );
}

/** How much of what finished went through: two blocks of one bar, and the sentence underneath. */
export function SuccessChart({ completed, failed }: { completed: number; failed: number }) {
  const finished = completed + failed;
  const percent = finished > 0 ? Math.round((completed / finished) * 100) : null;
  const said = percent === null ? copy.reports.rateNothing : copy.reports.rate(percent, completed, failed);
  return (
    <div data-testid="chart-rate" role="img" aria-label={said}>
      <p className="text-2xl font-semibold">{percent === null ? '—' : percent + '%'}</p>
      <div className="mt-2 flex h-6 overflow-hidden rounded-md border border-line bg-page">
        {finished > 0 && <span data-testid="rate-paid" className="h-full bg-brand" style={{ width: (completed / finished) * 100 + '%' }} />}
        {finished > 0 && <span data-testid="rate-failed" className="h-full bg-danger" style={{ width: (failed / finished) * 100 + '%' }} />}
      </div>
      <p className="mt-2 text-sm text-muted">{percent === null ? copy.reports.charts.rateNothing : copy.reports.charts.rateSplit(completed, failed)}</p>
    </div>
  );
}
