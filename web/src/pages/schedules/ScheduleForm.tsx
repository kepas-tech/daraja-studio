import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../../api/client';
import type { ContactView, Every, ScheduleView, SettingsView, WeekendRule } from '../../api/types';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { MoneyInput } from '../../components/MoneyInput';
import { PageHeader } from '../../components/PageHeader';
import { PasswordConfirmDialog } from '../../components/PasswordConfirmDialog';
import { TaskCard } from '../../components/TaskCard';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { useStepUp } from '../settings/useStepUp';
import { copy } from '../../copy/en';
import { day, money } from '../../format';

type Step = 1 | 2 | 3;
interface Line { key: number; contactId: string; amountCents: number | null; note: string }
const PHONE_MIN = 1000;
const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const select = 'min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink';

/**
 * Making or changing a schedule, in three steps: who is paid and how much, how often, and the
 * warning that spells out what happens on its own. Nothing is saved until the warning is accepted
 * and the step-up passes; that pair is the consent every run afterwards stands on.
 */
export function ScheduleForm() {
  const c = copy.schedules.form;
  const { id } = useParams();
  const go = useNavigate();
  const toast = useToast();
  const stepUp = useStepUp();
  const [step, setStep] = useState<Step>(1);
  const [contacts, setContacts] = useState<ContactView[] | null>(null);
  const [name, setName] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: 0, contactId: '', amountCents: null, note: '' }]);
  const [every, setEvery] = useState<Every>('monthly');
  const [weekday, setWeekday] = useState(4);
  const [dayOfMonth, setDayOfMonth] = useState(30);
  const [hour, setHour] = useState(9);
  const [weekendRule, setWeekendRule] = useState<WeekendRule>('on_day');
  const [phoneCommand, setPhoneCommand] = useState<'SalaryPayment' | 'BusinessPayment'>('SalaryPayment');
  const [startOn, setStartOn] = useState(today());
  const [endOn, setEndOn] = useState('');
  const [preview, setPreview] = useState<{ words: string; payDates: string[] } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [threshold, setThreshold] = useState(0);
  const [err, setErr] = useState<Error | null>(null);

  useEffect(() => { api.get<{ items: ContactView[] }>('/api/contacts').then((r) => setContacts(r.items)).catch(() => setContacts([])); }, []);
  useEffect(() => { api.get<SettingsView>('/api/settings').then((s) => setThreshold(s.approvalThresholdCents ?? 0)).catch(() => {}); }, []);
  useEffect(() => {
    if (!id) return;
    api.get<ScheduleView>(`/api/schedules/${id}`).then((s) => {
      setName(s.name); setEvery(s.every); setWeekday(s.weekday); setDayOfMonth(s.dayOfMonth); setHour(s.hour); setWeekendRule(s.weekendRule);
      setPhoneCommand(s.phoneCommand); setStartOn(s.startOn); setEndOn(s.endOn ?? '');
      setLines(s.lines.filter((l) => !l.gone).map((l, i) => ({ key: i, contactId: l.contactId, amountCents: l.amountCents, note: l.note ?? '' })));
    }).catch((e) => setErr(e instanceof Error ? e : new Error(copy.error.generic)));
  }, [id]);

  const byId = useMemo(() => new Map((contacts ?? []).map((x) => [x.id, x])), [contacts]);
  const lineOk = (l: Line) => {
    const who = byId.get(l.contactId);
    return !!who && l.amountCents !== null && l.amountCents > 0 && l.amountCents % 100 === 0 && (who.kind !== 'phone' || l.amountCents >= PHONE_MIN);
  };
  const picked = lines.map((l) => l.contactId).filter(Boolean);
  const step1Ok = name.trim().length > 0 && lines.length > 0 && lines.every(lineOk) && new Set(picked).size === picked.length;
  const total = lines.reduce((a, l) => a + (l.amountCents ?? 0), 0);
  const timetable = { every, weekday, dayOfMonth, hour, weekendRule, startOn, endOn: endOn || null };

  useEffect(() => {
    if (step !== 3) return;
    let live = true;
    setPreview(null); setAccepted(false);
    api.post<{ words: string; payDates: string[] }>('/api/schedules/preview', timetable).then((p) => { if (live) setPreview(p); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e : new Error(copy.error.generic)); });
    return () => { live = false; };
    // Read once per arrival at the warning: the timetable cannot change while it is on screen.
  }, [step]);

  const setLine = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const save = () => stepUp.ask(c.confirmTitle(name.trim()), async (confirm) => {
    const body = {
      name: name.trim(), ...timetable, phoneCommand, accepted: true,
      lines: lines.map((l) => ({ contactId: l.contactId, amountCents: l.amountCents, note: l.note.trim() || undefined })), ...confirm,
    };
    const s = id ? await api.put<ScheduleView>(`/api/schedules/${id}`, body) : await api.post<ScheduleView>('/api/schedules', body);
    toast.success(id ? c.saved : c.created);
    go(`/schedules/${s.id}`);
  });

  if (contacts !== null && contacts.length === 0) {
    return (<><PageHeader title={c.titleNew} /><p className="max-w-xl text-base">{copy.schedules.needContacts} <Link to="/contacts">{copy.nav.find((n) => n.key === 'contacts')?.label}</Link></p></>);
  }

  return (
    <>
      <PageHeader title={id ? c.titleEdit(name || '…') : c.titleNew} safaricom={copy.schedules.safaricom} />
      <div className="max-w-2xl space-y-4">
        <ErrorCard error={err} />
        {step === 1 && (
          <TaskCard footer={<Button type="button" disabled={!step1Ok} onClick={() => setStep(2)}>{c.next}</Button>}>
            <h2 className="text-xl font-semibold">{c.step1}</h2>
            <TextField label={c.name} hint={c.nameHint} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <ul className="space-y-3">
              {lines.map((l) => {
                const who = byId.get(l.contactId);
                return (
                  <li key={l.key} data-testid="schedule-line" className="space-y-2 rounded-md border border-line p-3">
                    <label className="block text-base font-semibold" htmlFor={`payee-${l.key}`}>{c.payee}</label>
                    <select id={`payee-${l.key}`} aria-label={c.payee} className={select} value={l.contactId} onChange={(e) => setLine(l.key, { contactId: e.target.value })}>
                      <option value="">{c.pick}</option>
                      {(contacts ?? []).map((x) => (
                        <option key={x.id} value={x.id} disabled={picked.includes(x.id) && x.id !== l.contactId}>
                          {x.name} · {x.kind === 'phone' ? x.phone : x.shortcode}{x.accountReference ? ' · ' + x.accountReference : ''}
                        </option>
                      ))}
                    </select>
                    <MoneyInput label={c.amount} valueCents={l.amountCents} onChange={(v) => setLine(l.key, { amountCents: v })} wholeShillings
                      error={who?.kind === 'phone' && l.amountCents !== null && l.amountCents < PHONE_MIN ? c.phoneMin : undefined} />
                    <TextField label={c.note} value={l.note} maxLength={100} onChange={(e) => setLine(l.key, { note: e.target.value })} />
                    {lines.length > 1 && <Button type="button" variant="secondary" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>{c.remove}</Button>}
                  </li>
                );
              })}
            </ul>
            <Button type="button" variant="secondary" disabled={lines.length >= 200} onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, contactId: '', amountCents: null, note: '' }])}>{c.addLine}</Button>
            <p className="font-semibold">{c.total(money(total))}</p>
          </TaskCard>
        )}

        {step === 2 && (
          <TaskCard footerStart={<Button type="button" variant="secondary" onClick={() => setStep(1)}>{c.back}</Button>}
            footer={<Button type="button" disabled={!startOn || (!!endOn && endOn < startOn)} onClick={() => setStep(3)}>{c.next}</Button>}>
            <h2 className="text-xl font-semibold">{c.step2}</h2>
            <label className="block text-base font-semibold" htmlFor="every">{c.every}</label>
            <select id="every" className={select} value={every} onChange={(e) => { const v = e.target.value as Every; setEvery(v); setWeekendRule('on_day'); }}>
              {(['daily', 'weekly', 'fortnightly', 'monthly'] as const).map((k) => <option key={k} value={k}>{c.everyOptions[k]}</option>)}
            </select>
            {(every === 'weekly' || every === 'fortnightly') && (<>
              <label className="block text-base font-semibold" htmlFor="weekday">{c.weekday}</label>
              <select id="weekday" className={select} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {c.weekdays.map((w, i) => <option key={w} value={i}>{w}</option>)}
              </select>
            </>)}
            {every === 'monthly' && (<>
              <label className="block text-base font-semibold" htmlFor="dom">{c.dayOfMonth}</label>
              <select id="dom" className={select} value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <p className="text-sm text-muted">{c.dayOfMonthHint}</p>
              <label className="block text-base font-semibold" htmlFor="weekend">{c.weekendMonthly}</label>
              <select id="weekend" className={select} value={weekendRule} onChange={(e) => setWeekendRule(e.target.value as WeekendRule)}>
                {(['on_day', 'before'] as const).map((k) => <option key={k} value={k}>{c.weekendOptions[k]}</option>)}
              </select>
            </>)}
            {every === 'daily' && (<>
              <label className="block text-base font-semibold" htmlFor="weekend">{c.weekendDaily}</label>
              <select id="weekend" className={select} value={weekendRule} onChange={(e) => setWeekendRule(e.target.value as WeekendRule)}>
                {(['on_day', 'skip'] as const).map((k) => <option key={k} value={k}>{c.dailyOptions[k]}</option>)}
              </select>
            </>)}
            <label className="block text-base font-semibold" htmlFor="hour">{c.hour}</label>
            <select id="hour" className={select} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => h).map((h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
            </select>
            <TextField label={c.startOn} type="date" value={startOn} min={today()} onChange={(e) => setStartOn(e.target.value)} />
            <TextField label={c.endOn} hint={c.endOnHint} type="date" value={endOn} min={startOn} onChange={(e) => setEndOn(e.target.value)} />
            {lines.some((l) => byId.get(l.contactId)?.kind === 'phone') && (<>
              <label className="block text-base font-semibold" htmlFor="command">{c.phoneCommand}</label>
              <select id="command" className={select} value={phoneCommand} onChange={(e) => setPhoneCommand(e.target.value as 'SalaryPayment' | 'BusinessPayment')}>
                {(['SalaryPayment', 'BusinessPayment'] as const).map((k) => <option key={k} value={k}>{c.phoneCommands[k]}</option>)}
              </select>
            </>)}
          </TaskCard>
        )}

        {step === 3 && (
          <TaskCard footerStart={<Button type="button" variant="secondary" onClick={() => setStep(2)}>{c.back}</Button>}
            footer={<Button type="button" disabled={!accepted || !preview || preview.payDates.length === 0} onClick={save}>{id ? c.saveEdit : c.save}</Button>}>
            <h2 className="text-xl font-semibold">{c.step3}</h2>
            <Flash tone="danger" role="alert" data-testid="schedule-warning">
              <p className="font-semibold">{c.warningTitle}</p>
              <p>{preview ? c.warning(money(total), lines.length, preview.words) : copy.app.loading}</p>
            </Flash>
            {preview && (preview.payDates.length === 0 ? <p className="text-base">{c.noDates}</p> : (
              <div>
                <p className="font-semibold">{c.firstDates}</p>
                <ul className="list-disc pl-6">{preview.payDates.map((d) => <li key={d}>{day(d)}: {money(total)}</li>)}</ul>
              </div>
            ))}
            <ul className="list-disc space-y-1 pl-6 text-sm text-muted">{c.rules.map((r) => <li key={r}>{r}</li>)}</ul>
            {threshold > 0 && lines.some((l) => (l.amountCents ?? 0) >= threshold) && <p className="text-sm">{c.approvalNote(money(threshold))}</p>}
            <label className="flex items-start gap-3 text-base">
              <input type="checkbox" className="mt-1 size-5" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>{c.accept}</span>
            </label>
          </TaskCard>
        )}
      </div>
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
