import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { BusinessSweep, Confirm, SweepFee, SweepList, SweepRow, SweepSchedule } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { MoneyInput } from '../components/MoneyInput';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { PhoneInput } from '../components/PhoneInput';
import { Segmented } from '../components/Segmented';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import { useStepUp } from './settings/useStepUp';

/**
 * Step three of nine: sweep-through.
 *
 * One card per business: where its money goes, when it goes, what is kept, and what it is owed with
 * the payments that make the figure up. Setting the phone or the timetable up asks for the
 * password, because it decides where money goes; stopping is one press, because stopping has to be
 * the easy thing to do. Nothing here writes a balance — every figure on the page is a sum the
 * server worked out from the rows, and the reason nothing has left is the server's own sentence.
 */

/**
 * The same three lines the server works out in src/sweep/fee.ts, so the fee can be shown before it
 * is saved. What the server records on the sweep is the figure that counts; this is the estimate
 * beside the form, and the two agree because the arithmetic is the same and short.
 */
function feeOn(grossCents: number, fee: SweepFee): number {
  if (grossCents <= 0) return 0;
  const shilling = (c: number) => Math.round(c / 100) * 100;
  let out = shilling((grossCents * fee.percentBp) / 10_000) + fee.flatCents;
  if (fee.floorCents !== null) out = Math.max(out, fee.floorCents);
  if (fee.ceilingCents !== null) out = Math.min(out, fee.ceilingCents);
  return Math.max(0, Math.min(out, grossCents));
}

interface Draft {
  phone: string;
  schedule: SweepSchedule;
  hour: number;
  weekday: number;
  percent: string;
  flatCents: number | null;
  floorCents: number | null;
  ceilingCents: number | null;
}

const control = 'min-h-11 rounded-md border border-line bg-surface px-3 text-base text-ink';

/** The words for a fee, in the owner's terms. "No fee" is said, never left blank. */
function feeWords(fee: SweepFee): string {
  const c = copy.sweepPage;
  const parts: string[] = [];
  if (fee.percentBp > 0) parts.push(c.percent(String(fee.percentBp / 100)));
  if (fee.flatCents > 0) parts.push(money(fee.flatCents));
  return c.feeWords(
    parts.length > 1 ? parts[0] : '',
    parts.length > 0 ? parts[parts.length - 1] : '',
    fee.floorCents ? money(fee.floorCents) : '',
    fee.ceilingCents ? money(fee.ceilingCents) : '',
  );
}

/** One sweep, with the receipt the business can check and the reason when it did not go. */
function SweepLine({ s }: { s: SweepRow }) {
  const c = copy.sweepPage;
  const tone = s.state === 'sent' ? 'ok' : s.state === 'failed' ? 'bad' : s.state === 'held' ? 'warn' : 'muted';
  return (
    <li className="border-t border-line py-2 first:border-t-0" data-testid={'sweep-row-' + s.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <StatusPill kind={tone}>{c.state[s.state] ?? s.state}</StatusPill>
          <span className="text-base">{s.state === 'sent' ? c.sentLine(money(s.netCents), money(s.feeCents)) : c.heldLine(money(s.grossCents))}</span>
        </span>
        <span className="text-sm text-muted">{c.madeAt(when(s.createdAt))}</span>
      </div>
      <p className="text-sm text-muted">
        {s.receipt ? c.receipt(s.receipt) : s.requestStatus === 'awaiting_approval' ? c.awaitingApproval : s.state === 'sending' ? c.stillInFlight : s.reason ?? ''}
      </p>
    </li>
  );
}

/** The form that decides where a business's money goes. Nothing is saved until the password is in. */
function SweepForm({ b, onSave, onCancel }: { b: BusinessSweep; onSave: (d: Draft) => void; onCancel: () => void }) {
  const c = copy.sweepPage;
  const [d, setD] = useState<Draft>({
    phone: b.destinationPhone ?? '', schedule: b.schedule, hour: b.hour, weekday: b.weekday,
    percent: b.fee.percentBp > 0 ? String(b.fee.percentBp / 100) : '',
    flatCents: b.fee.flatCents || null, floorCents: b.fee.floorCents, ceilingCents: b.fee.ceilingCents,
  });
  const fee: SweepFee = {
    percentBp: Math.max(0, Math.round((Number(d.percent) || 0) * 100)),
    flatCents: d.flatCents ?? 0, floorCents: d.floorCents, ceilingCents: d.ceilingCents,
  };
  const take = feeOn(b.owed.owedCents, fee);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="space-y-4 rounded-md border border-line bg-page p-4" data-testid={'sweep-form-' + b.businessId}>
      <PhoneInput label={c.phone} value={d.phone} onChange={(v) => setD({ ...d, phone: v })} />
      <div className="space-y-2">
        <span className="block text-base font-semibold">{c.when}</span>
        <Segmented name={'schedule-' + b.businessId} label={c.when} value={d.schedule} onChange={(v) => setD({ ...d, schedule: v })}
          options={[{ value: 'arrival', label: c.asItArrives }, { value: 'daily', label: c.everyDay }, { value: 'weekly', label: c.everyWeek }]} />
        {d.schedule === 'daily' && (
          <label className="flex items-center gap-2">
            <span className="text-base">{c.atHour}</span>
            <select aria-label={c.atHour} className={control} value={d.hour} onChange={(e) => setD({ ...d, hour: Number(e.target.value) })}>
              {hours.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0') + ':00'}</option>)}
            </select>
          </label>
        )}
        {d.schedule === 'weekly' && (
          <label className="flex items-center gap-2">
            <span className="text-base">{c.onDay}</span>
            <select aria-label={c.onDay} className={control} value={d.weekday} onChange={(e) => setD({ ...d, weekday: Number(e.target.value) })}>
              {c.weekdays.map((w, i) => <option key={w} value={i}>{w}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="space-y-2">
        <span className="block text-base font-semibold">{c.feeTitle}</span>
        <p className="text-sm text-muted">{c.feeIntro}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-base font-medium">{c.feePercent}</span>
            <input className={'w-full ' + control} inputMode="decimal" value={d.percent} aria-label={c.feePercent}
              onChange={(e) => setD({ ...d, percent: e.target.value })} />
          </label>
          <MoneyInput label={c.feeFlat} valueCents={d.flatCents} onChange={(v) => setD({ ...d, flatCents: v })} hint={c.feeOptional} />
          <MoneyInput label={c.feeFloor} valueCents={d.floorCents} onChange={(v) => setD({ ...d, floorCents: v })} hint={c.feeOptional} />
          <MoneyInput label={c.feeCeiling} valueCents={d.ceilingCents} onChange={(v) => setD({ ...d, ceilingCents: v })} hint={c.feeOptional} />
        </div>
        {b.owed.owedCents > 0 && <p className="text-base">{c.feePreview(money(b.owed.owedCents), money(take), money(b.owed.owedCents - take))}</p>}
      </div>
      <div className="space-y-1 rounded-md border border-brand bg-brand-tint/40 p-3">
        <p className="text-base font-semibold">{c.consentTitle}</p>
        <p className="text-base">{c.consent}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={d.phone.trim().length === 0} onClick={() => onSave(d)}>{c.save}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{c.cancel}</Button>
      </div>
    </div>
  );
}

export function Sweep() {
  const { status, person, permissions } = useSession();
  const toast = useToast();
  const stepUp = useStepUp();
  const c = copy.sweepPage;
  const [data, setData] = useState<SweepList | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const mayManage = !!person?.is_owner || permissions.includes('sweep.manage');

  const load = useCallback(async () => { setData(await api.get<SweepList>('/api/sweep')); }, []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);

  const replace = (next: BusinessSweep) => setData((cur) => (cur ? { ...cur, items: cur.items.map((x) => (x.businessId === next.businessId ? next : x)) } : cur));

  const save = (b: BusinessSweep, d: Draft) => {
    stepUp.ask(c.stepUpTitle(b.businessName), async (confirm: Confirm) => {
      const next = await api.post<BusinessSweep>('/api/sweep/' + b.businessId, {
        destinationPhone: d.phone.trim() ? d.phone.trim() : null,
        schedule: d.schedule, hour: d.hour, weekday: d.weekday,
        fee: { percentBp: Math.max(0, Math.round((Number(d.percent) || 0) * 100)), flatCents: d.flatCents ?? 0, floorCents: d.floorCents, ceilingCents: d.ceilingCents },
        ...confirm,
      });
      replace(next);
      setEditing(null);
      setErr(null);
      toast.success(c.saved);
    });
  };

  // One press: no dialog, no password. The money stays owed and visible either way.
  const toggleStopped = async (b: BusinessSweep) => {
    try {
      replace(await api.post<BusinessSweep>('/api/sweep/' + b.businessId + '/stop', { stopped: !b.stopped }));
      setErr(null);
      toast.success(b.stopped ? c.startToast(b.businessName) : c.stoppedToast(b.businessName));
    } catch (e) { setErr(explainApiError(e)); }
  };

  if (status === 'loading') return <Loading />;
  if (err && !data) return <><PageHeader title={c.title} /><ErrorCard error={err} /></>;
  if (!data) return <Loading />;

  return (
    <>
      <PageHeader title={c.title} subtitle={c.subtitle} />
      <ErrorCard error={err} />
      {data.items.length === 0 && <Card bodyClassName="p-4"><p className="text-base text-muted">{c.empty}</p></Card>}

      {data.items.map((b) => (
        <Card key={b.businessId} className="mb-6" bodyClassName="space-y-4 p-4" data-testid={'sweep-' + b.businessId}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <h2 className="text-lg font-semibold">{b.businessName} <span className="text-sm font-normal text-muted">{b.businessCode}</span></h2>
              <p className="text-base">
                {b.stopped ? <StatusPill kind="muted">{c.stop}</StatusPill> : b.destinationPhone ? <StatusPill kind="ok">{c.goesTo}: {phone(b.destinationPhone)}</StatusPill> : <StatusPill kind="warn">{c.noPhone}</StatusPill>}
              </p>
              <p className="text-sm text-muted">{c.everyWhen}: {b.timetable}</p>
              <p className="text-sm text-muted">{c.feeLabel}: {feeWords(b.fee)}</p>
              {b.consentedAt && <p className="text-sm text-muted">{c.consentGiven(when(b.consentedAt))}</p>}
            </div>
            {mayManage && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => setEditing(editing === b.businessId ? null : b.businessId)}>{b.destinationPhone ? c.change : c.setUp}</Button>
                <Button type="button" variant="secondary" onClick={() => void toggleStopped(b)}>{b.stopped ? c.start : c.stop}</Button>
              </div>
            )}
          </div>

          {editing === b.businessId && <SweepForm b={b} onSave={(d) => save(b, d)} onCancel={() => setEditing(null)} />}

          <div className="rounded-md border border-line p-3" data-testid={'owed-' + b.businessId}>
            <p className="text-base font-semibold">{c.owedTitle}: {money(b.owed.owedCents)}</p>
            {b.owed.owedCents === 0 && <p className="text-sm text-muted">{c.owedNothing}</p>}
            {b.owed.owedCents > 0 && (
              <>
                <p className="text-sm text-muted">{c.owedFrom(b.owed.payments.length)}</p>
                <ul className="mt-2 space-y-1">
                  {b.owed.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-base">
                      <span>{p.receipt ?? p.id}{p.accountNumber ? ' · ' + p.accountNumber : ''}</span>
                      <span className="text-muted">{money(p.amountCents)} · {when(p.at)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-2 text-sm text-muted">{c.paidIn}: {money(b.owed.paidInCents)} · {c.alreadySent}: {money(b.owed.sweptCents)} · {c.feesTaken}: {money(b.owed.feesTakenCents)}</p>
            <p className="mt-1 text-sm text-muted">{c.minimumLine(money(b.minCents))}</p>
          </div>

          {/* The server's own sentence for why nothing has left, printed as it wrote it. */}
          {b.waiting && <p className="rounded-md border border-line bg-page p-3 text-base" data-testid={'waiting-' + b.businessId}>{b.waiting.text}</p>}

          <div>
            <p className="text-base font-semibold">{c.sweepsTitle}</p>
            {b.sweeps.length === 0
              ? <p className="text-sm text-muted">{c.sweepsNone}</p>
              : <ul className="mt-2">{b.sweeps.map((s) => <SweepLine key={s.id} s={s} />)}</ul>}
          </div>
        </Card>
      ))}

      {!mayManage && data.items.length > 0 && <p className="mt-4 text-sm text-muted">{c.noManage}</p>}
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
