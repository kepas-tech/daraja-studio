import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client';
import type { ScheduleView } from '../../api/types';
import { Card, cardRow } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { StatusPill } from '../../components/StatusPill';
import { copy } from '../../copy/en';
import { day, money } from '../../format';

/** A link that looks like the page's main button. */
export const linkButton = 'inline-flex min-h-11 items-center justify-center rounded-md border border-brand bg-brand px-4 text-base font-semibold text-surface hover:bg-brand-dark hover:no-underline';
export const STATE_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = { active: 'ok', paused: 'warn', stopped: 'muted', finished: 'muted' };

/** Every schedule, the ones that are on first, each in one plain line. */
export function ScheduleList() {
  const c = copy.schedules;
  const [items, setItems] = useState<ScheduleView[] | null>(null);
  useEffect(() => { api.get<{ items: ScheduleView[] }>('/api/schedules').then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom} />
      <div className="max-w-2xl space-y-4">
        <p className="text-base">{c.intro}</p>
        <Link to="/schedules/new" className={linkButton}>{c.new}</Link>
        {items === null ? <p className="text-muted">{copy.app.loading}</p> : items.length === 0 ? <p className="text-muted">{c.none}</p> : (
          <Card bodyClassName="p-0">
            <ul>
              {items.map((s) => (
                <li key={s.id} className={`${cardRow} flex flex-wrap items-center justify-between gap-3`}>
                  <span className="min-w-0">
                    <Link to={`/schedules/${s.id}`} className="font-semibold">{s.name}</Link>
                    <span className="block text-sm text-muted">{s.words}</span>
                    <span className="block text-sm">{c.line(s.lines.filter((l) => !l.gone).length, money(s.totalCents), s.state === 'active' ? (s.nextPayOn ? day(s.nextPayOn) : null) : null)}</span>
                  </span>
                  <StatusPill kind={STATE_TONE[s.state] ?? 'muted'}>{c.state[s.state] ?? s.state}</StatusPill>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
