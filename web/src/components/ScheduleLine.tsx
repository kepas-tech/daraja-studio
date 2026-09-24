import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { ScheduleSummary } from '../api/types';
import { copy } from '../copy/en';
import { day, money } from '../format';
import { Button } from './Button';
import { useToast } from './Toast';

/**
 * The standing line on Home while any schedule is on. It is a state, not a notification: it shows
 * for as long as it is true and goes the moment the last schedule is stopped. Its actions are on the
 * line itself: see them all, pause the next one, and stop it (on its own page, behind the step-up
 * and its name typed back, because an accidental stop means people do not get paid).
 */
export function ScheduleLine({ reloadKey = 0 }: { reloadKey?: number }) {
  const c = copy.schedules.home;
  const toast = useToast();
  const [s, setS] = useState<ScheduleSummary | null>(null);
  const load = useCallback(() => { api.get<ScheduleSummary>('/api/schedules/summary').then(setS).catch(() => setS(null)); }, []);
  useEffect(load, [load, reloadKey]);
  if (!s || (s.active === 0 && s.paused === 0)) return null;
  const pause = async () => {
    if (!s.next) return;
    try { await api.post(`/api/schedules/${s.next.id}/pause`, {}); toast.info(c.paused1); load(); }
    catch { toast.error(copy.error.generic); }
  };
  return (
    <div data-testid="home-schedules" className="mb-6 rounded-md border border-line bg-surface px-4 py-3 text-base">
      {s.next && <p className="font-semibold">{c.line(s.active, s.next.name, money(s.next.totalCents), day(s.next.payOn))}</p>}
      {s.paused > 0 && <p className="text-sm text-muted">{c.paused(s.paused)}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Link to="/schedules">{c.seeAll}</Link>
        {s.next && <Button type="button" variant="secondary" onClick={() => void pause()}>{c.pause}</Button>}
        {s.next && <Link to={`/schedules/${s.next.id}`} className="text-danger">{c.stop}</Link>}
      </div>
    </div>
  );
}
