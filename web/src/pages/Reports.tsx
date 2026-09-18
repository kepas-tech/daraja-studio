import { useCallback, useEffect, useState } from 'react';
import { api, saveDownload } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { Segmented } from '../components/Segmented';
import { useToast } from '../components/Toast';
import { DayChart, StatusChart, SuccessChart } from '../components/Charts';
import { copy } from '../copy/en';
import { typeOf } from '../businessTypes';
import { money } from '../format';
import type { BusinessSummaryRow, BusinessView, ReportsView } from '../api/types';

/** The three windows the server accepts. Anything else is refused there too, never silently defaulted. */
const WINDOWS = ['7', '30', '90'] as const;
type Window = (typeof WINDOWS)[number];

/** A Nairobi day from the server, read as the owner's own calendar reads it (never shifted by UTC). */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * Feature 6. How the week went: a window, the days in it, and Safaricom's own reasons for the
 * payments that failed. Every number here is money that moved; balance checks and lookups are
 * housekeeping and appear nowhere. Read-only: nothing on this page writes a row.
 */
export function Reports() {
  const toast = useToast();
  const { person, permissions } = useSession();
  // These are the owner's own numbers, so the file is the owner's (or somebody given history.export).
  const mayExport = !!person?.is_owner || permissions.includes('history.export');
  const [days, setDays] = useState<Window>('7');
  const [business, setBusiness] = useState('');
  const [businesses, setBusinesses] = useState<BusinessView[]>([]);
  const [view, setView] = useState<ReportsView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState<Error | Explained | null>(null);

  // The filter is the same read History makes; with one business there is nothing to choose.
  useEffect(() => { api.get<{ items: BusinessView[] }>('/api/businesses').then((r) => setBusinesses(r.items)).catch(() => setBusinesses([])); }, []);

  // One definition of the window, shared by the page and its file, so the two can never disagree.
  const query = useCallback(() => {
    const p = new URLSearchParams();
    p.set('days', days);
    if (business) p.set('businessId', business);
    return p;
  }, [days, business]);
  const load = useCallback(() => {
    api.get<ReportsView>(`/api/reports?${query().toString()}`)
      .then((r) => { setView(r); setErr(null); })
      .catch((e) => { setView(null); setErr(explainApiError(e)); });
  }, [query]);
  useEffect(load, [load]);
  // A payment that finishes while the page is open moves these numbers; a reconnect re-reads them.
  useEvents(useCallback((e) => { if (e.type === 'request.updated') load(); }, [load]), true, load);

  const exportFile = async () => {
    setExporting(true); setExportErr(null);
    try {
      saveDownload(await api.download(`/api/reports/export.csv?${query().toString()}`), 'reports.csv');
      toast.success(copy.reports.exported);
    } catch (e) { setExportErr(explainApiError(e)); toast.error(copy.error.exportFailed); }
    finally { setExporting(false); }
  };

  // The rate is completed over completed plus failed. "We do not know yet" is neither, so it stays
  // out of both the top and the bottom of that fraction.
  const finished = view ? view.totals.completed + view.totals.failed : 0;
  const percent = view && finished > 0 ? Math.round((view.totals.completed / finished) * 100) : null;
  const control = 'min-h-10 rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  const cell = 'px-4 py-3 whitespace-nowrap';
  const th = 'px-4 py-2 font-medium';
  // Round 3, phase B: with one business in view, this is that business's statement, and its kind of
  // business says what the statement is called. With several, the page is the studio's own report.
  const picked = businesses.find((b) => b.id === business) ?? (businesses.length === 1 ? businesses[0] : null);
  return (
    <>
      <PageHeader title={picked ? copy.reports.statement(typeOf(picked).template.statementNoun) : copy.reports.title} />
      <Card bodyClassName="p-0" className="mb-6">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-4 py-3">
          <div className="min-w-64 flex-1">
            <Segmented name="reports-window" label={copy.reports.window} value={days} options={WINDOWS.map((w) => ({ value: w, label: copy.reports.windows[w] }))} onChange={setDays} />
          </div>
          {businesses.length > 1 && (
            <select aria-label={copy.reports.business} className={control} value={business} onChange={(e) => setBusiness(e.target.value)}>
              <option value="">{copy.reports.anyBusiness}</option>
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
            </select>
          )}
          {mayExport && <Button type="button" variant="secondary" disabled={exporting} onClick={() => void exportFile()}>{exporting ? copy.reports.exporting : copy.reports.export}</Button>}
        </div>
        {exportErr && <div className="border-b border-line p-4"><ErrorCard error={exportErr} /></div>}
        {err && <div className="border-b border-line p-4"><ErrorCard error={err} /></div>}
        {!view && !err && <Loading />}
        {view && (
          <>
            <div className="border-b border-line px-4 py-3 text-base">
              <p className="font-semibold">{copy.reports.totals}</p>
              <p className="mt-1">
                <span className="font-semibold">{copy.reports.in}</span> {copy.reports.totalIn(money(view.totals.inCents), view.totals.inCount)}
                {' · '}
                <span className="font-semibold">{copy.reports.out}</span> {copy.reports.totalOut(money(view.totals.outCents), view.totals.outCount)}
              </p>
              <p className="mt-1">{percent === null ? copy.reports.rateNothing : copy.reports.rate(percent, view.totals.completed, view.totals.failed)} <span className="text-sm text-muted">{copy.reports.rateNote}</span></p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <caption className="sr-only">{copy.reports.tableCaption}</caption>
                <thead><tr className="text-left text-sm text-muted">
                  {Object.values(copy.reports.columns).map((c) => <th key={c} className={th}>{c}</th>)}
                </tr></thead>
                <tbody>{view.days.map((d) => (
                  <tr key={d.day} className="border-t border-line" data-testid={`report-day-${d.day}`}>
                    <td className={cell}>{dayLabel(d.day)}</td>
                    <td className={cell}>{money(d.inCents)}</td>
                    <td className={cell}>{d.inCount}</td>
                    <td className={cell}>{money(d.outCents)}</td>
                    <td className={cell}>{d.outCount}</td>
                    <td className={cell}>{d.completed}</td>
                    <td className={cell}>{d.failed}</td>
                    <td className={cell}>{d.unknown}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line px-4 py-3 text-base font-semibold">
              {copy.reports.totals}: {money(view.totals.inCents)} {copy.reports.in.toLowerCase()} · {money(view.totals.outCents)} {copy.reports.out.toLowerCase()}
            </div>
          </>
        )}
      </Card>

      {/* Round 3, phase D-7: the same window as three pictures, above the tables that carry the
          numbers. Drawn from this page's own read, so they cannot tell a different story. */}
      {view && (
        <Card title={copy.reports.charts.title} className="mb-6">
          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <p className="mb-2 text-sm font-semibold">{copy.reports.charts.days}</p>
              <DayChart days={view.days} label={dayLabel} />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">{copy.reports.charts.status}</p>
              <StatusChart totals={view.totals} />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold">{copy.reports.charts.rate}</p>
              <SuccessChart completed={view.totals.completed} failed={view.totals.failed} />
            </div>
          </div>
        </Card>
      )}

      {view && (
        <Card title={copy.reports.failuresTitle} bodyClassName="p-0" className="mb-6">
          {view.failures.length === 0 ? <p className="p-4 text-base text-muted">{copy.reports.failuresEmpty}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-base">
                <thead><tr className="text-left text-sm text-muted">
                  <th className={th}>{copy.reports.failureColumns.reason}</th>
                  <th className={th}>{copy.reports.failureColumns.count}</th>
                  <th className={th}>{copy.reports.failureColumns.amount}</th>
                </tr></thead>
                <tbody>{view.failures.map((f) => (
                  <tr key={f.reason} className="border-t border-line">
                    <td className="px-4 py-3">{f.reason}</td>
                    <td className={cell}>{f.count}</td>
                    <td className={cell}>{money(f.amountCents)}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {view && view.byBusiness.length > 0 && (
        <Card title={copy.reports.byBusiness} bodyClassName="p-0">
          <div className="border-b border-line px-4 py-3 text-sm text-muted">{copy.reports.byBusinessNote}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead><tr className="text-left text-sm text-muted">
                <th className={th}>{copy.reports.business}</th>
                <th className={th}>{copy.reports.in}</th>
                <th className={th}>{copy.reports.out}</th>
              </tr></thead>
              <tbody>{view.byBusiness.map((b: BusinessSummaryRow) => (
                <tr key={b.businessId} className="border-t border-line" data-testid={'report-business-' + b.businessId}>
                  <td className="px-4 py-3"><code>{b.code}</code> · {b.name}</td>
                  <td className={cell}>{money(b.inCents)}</td>
                  <td className={cell}>{money(b.outCents)}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
