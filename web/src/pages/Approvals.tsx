import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import type { RequestView, WaitingSection, WaitingView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, when } from '../format';
import { PartyLine, partyWord } from '../components/PartyLine';
import { useStepUp } from './settings/useStepUp';

/**
 * Feature 5: one page for money that has not finished — held for a second person, sent and not yet
 * answered, and given up on. Each row shows how long it has waited, and the one action that helps.
 * Release asks for the password (money leaves); Refuse asks for a reason (nothing leaves, but the
 * maker deserves to know why).
 */

/** How long a row has waited: minutes, then hours, then days. The age is the point of this page. */
export function ageOf(from: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(from).getTime()) / 60_000));
  if (minutes < 1) return copy.waiting.justNow;
  if (minutes < 60) return copy.waiting.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy.waiting.hours(hours);
  const days = Math.floor(hours / 24);
  return days === 1 ? copy.waiting.yesterday : copy.waiting.days(days);
}

/** What a row is: the business's own category first, then Safaricom's command name, then its type. */
const whatOf = (r: RequestView) => r.category ?? copy.request.subtype[r.subtype ?? ''] ?? copy.request.type[r.type] ?? r.type;

/** One of the two Safaricom sections. Everything the row needs is in the table, age included. */
function WaitingRows({ section, onCheck, checking }: { section: WaitingSection; onCheck: (r: RequestView) => void; checking: string | null }) {
  const w = copy.waiting;
  return (
    <Card bodyClassName='p-0'>
      <div className='overflow-x-auto'>
        <table className='w-full text-base'>
          <thead><tr className='text-left text-sm text-muted'>
            {Object.values(w.columns).map((h) => <th key={h} className='px-4 py-2 font-medium'>{h}</th>)}
            <th className='px-4 py-2 font-medium'>{w.age}</th>
            <th className='px-4 py-2' />
          </tr></thead>
          <tbody>{section.items.map((r) => (
            <tr key={r.id} className='border-t border-line'>
              <td className='px-4 py-3 whitespace-nowrap'>{when(r.createdAt)}</td>
              <td className='px-4 py-3'>{whatOf(r)}</td>
              {/* Round 3, phase A: the person leads and the number sits under them. */}
              <td className='px-4 py-3'><PartyLine r={r} to={'/requests/' + r.id} /></td>
              <td className='px-4 py-3 whitespace-nowrap'>{money(r.amountCents)}</td>
              <td className='px-4 py-3'>{copy.request.status[r.status] ?? r.status}</td>
              <td className='px-4 py-3 whitespace-nowrap'>{ageOf(r.sentAt ?? r.createdAt)}</td>
              <td className='px-4 py-3 whitespace-nowrap'><Button type='button' variant='secondary' disabled={checking === r.id} onClick={() => onCheck(r)}>{w.check}</Button></td>
            </tr>))}</tbody>
        </table>
      </div>
      {section.count > section.items.length && <p className='border-t border-line px-4 py-2 text-sm text-muted'>{w.cutOff(section.items.length, section.count)}</p>}
    </Card>
  );
}

export function Approvals() {
  const toast = useToast();
  const { person } = useSession();
  const stepUp = useStepUp();
  const c = copy.approvals;
  const w = copy.waiting;
  const [view, setView] = useState<WaitingView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  const load = useCallback(() => api.get<WaitingView>('/api/waiting').then(setView), []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'request.updated') void load().catch(() => {}); }, [load]));

  const release = (r: RequestView) => stepUp.ask(c.confirmRelease(money(r.amountCents)), async (confirm) => {
    await api.post(`/api/approvals/${r.id}/release`, { ...confirm });
    toast.success(c.released);
    await load();
  });
  const refuse = async (r: RequestView) => {
    setBusy(true); setErr(null);
    try { await api.post(`/api/approvals/${r.id}/refuse`, { reason: reason.trim() }); toast.success(c.refused); setRefusing(null); setReason(''); await load(); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  // Free of side effects on our side: it asks Safaricom about the row and the answer arrives the
  // same way a callback does. A refusal (no permission for that kind) shows as the usual error.
  const check = async (r: RequestView) => {
    setChecking(r.id); setErr(null);
    try { await api.post(`/api/requests/${r.id}/check`); toast.info(w.checkSent); await load(); }
    catch (e) { setErr(explainApiError(e)); }
    finally { setChecking(null); }
  };

  if (!view) return <><PageHeader title={w.title} safaricom={w.safaricom} />{err ? <ErrorCard error={err} /> : <Loading />}</>;
  // The badge counts held plus unanswered rows; the held rows themselves are only sent to somebody
  // who may decide, so the count is what a reader without the permission is told.
  const held = Math.max(0, view.badge - view.noAnswer.count);
  const nothing = view.sent.items.length === 0 && view.noAnswer.items.length === 0 && held === 0;
  return (
    <>
      <PageHeader title={w.title} safaricom={w.safaricom} />
      <p className='mb-4 text-base text-muted'>{w.intro}</p>
      <ErrorCard error={err} />
      {nothing ? <Card bodyClassName='p-4'><p className='text-base text-muted'>{w.empty}</p></Card> : (
        <div className='space-y-6'>
          {held > 0 && (
            <section>
              <h2 className='text-lg font-semibold'>{w.approvals} ({held})</h2>
              <p className='mb-2 text-sm text-muted'>{w.approvalsNote}</p>
              {!view.approvals.canDecide && <p className='mb-3 text-base'>{w.cannotDecide(held)}</p>}
              <div className='space-y-4'>
                {view.approvals.items.map((r) => {
                  const own = r.createdBy?.id === person?.id;
                  return (
                    <Card key={r.id} title={money(r.amountCents)} actions={<span className='text-sm text-muted'>{when(r.createdAt)}</span>} bodyClassName='space-y-3 p-4'>
                      <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base'>
                        <dt className='text-muted'>{partyWord(r)}</dt><dd><PartyLine r={r} to={`/requests/${r.id}`} /></dd>
                        {r.category && <><dt className='text-muted'>{copy.request.category}</dt><dd>{r.category}</dd></>}
                        {r.remarks && <><dt className='text-muted'>{copy.send.phone.remarks}</dt><dd>{r.remarks}</dd></>}
                        <dt className='text-muted'>{c.madeBy}</dt><dd>{r.createdBy?.displayName ?? '—'}</dd>
                        <dt className='text-muted'>{w.age}</dt><dd>{ageOf(r.createdAt)}</dd>
                      </dl>
                      {own ? <p className='text-sm text-muted'>{c.own}</p> : refusing === r.id ? (
                        <div className='space-y-2'>
                          <TextField label={c.reason} hint={c.reasonHint} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                          <div className='flex flex-wrap gap-2'>
                            <Button variant='danger' disabled={busy || reason.trim().length === 0} onClick={() => void refuse(r)}>{c.refuse}</Button>
                            <Button variant='secondary' onClick={() => { setRefusing(null); setReason(''); }}>{copy.confirm.cancel}</Button>
                          </div>
                        </div>
                      ) : (
                        <div className='flex flex-wrap gap-2'>
                          <Button onClick={() => release(r)}>{c.release}</Button>
                          <Button variant='secondary' onClick={() => { setRefusing(r.id); setReason(''); }}>{c.refuse}</Button>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            </section>
          )}
          {view.sent.items.length > 0 && (
            <section>
              <h2 className='text-lg font-semibold'>{w.sent} ({view.sent.count})</h2>
              <p className='mb-2 text-sm text-muted'>{w.sentNote}</p>
              <WaitingRows section={view.sent} onCheck={check} checking={checking} />
            </section>
          )}
          {view.noAnswer.items.length > 0 && (
            <section>
              <h2 className='text-lg font-semibold'>{w.noAnswer} ({view.noAnswer.count})</h2>
              <p className='mb-2 text-sm text-muted'>{w.noAnswerNote}</p>
              <WaitingRows section={view.noAnswer} onCheck={check} checking={checking} />
            </section>
          )}
        </div>
      )}
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
