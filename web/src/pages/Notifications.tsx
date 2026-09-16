import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { notificationsChanged } from '../api/notifications';
import type { NotificationPage, NotificationSeverity, NotificationView } from '../api/types';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { Segmented } from '../components/Segmented';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { when } from '../format';

/**
 * Four levels, four dots: grey for news, green for money that moved, dark green for something that
 * wants a look, red for a fault. Colour is never the only signal — the level is also read out for a
 * screen reader, and the sentence says what happened.
 */
const DOT: Record<NotificationSeverity, string> = {
  info: 'bg-muted',
  success: 'bg-brand',
  warning: 'bg-brand-dark',
  critical: 'bg-danger',
};

const PAGE_SIZE = 50;
type Filter = 'all' | 'unread';

/** What happened while nobody was looking. Sentences, with the amount and the name already in them. */
export function Notifications() {
  const c = copy.notifications;
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | Explained | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await api.get<NotificationPage>(`/api/notifications?filter=${filter}&limit=${PAGE_SIZE}`);
      setItems(p.items); setUnread(p.unread); setErr(null);
    } catch (e) { setErr(explainApiError(e)); setItems([]); }
  }, [filter]);
  useEffect(() => { void load(); }, [load]);
  // A line written while this page is open shows up on its own.
  useEvents(useCallback((e) => { if (e.type === 'notification.created') void load(); }, [load]));

  // Both writes answer with the server's own count on the next read, so the page never guesses.
  const markAll = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ read: number }>('/api/notifications/read-all');
      toast.success(c.markedAll(r.read));
      notificationsChanged();
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };
  const markOne = async (n: NotificationView) => {
    try {
      await api.post(`/api/notifications/${n.id}/read`);
      notificationsChanged();
      await load();
    } catch (e) { setErr(explainApiError(e)); }
  };

  return (
    <>
      <PageHeader title={c.title} />
      <p className="mb-4 text-base text-muted">{c.intro}</p>
      <ErrorCard error={err} />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-page px-4 py-3">
          <div className="w-56"><Segmented name="filter" label={c.filterLabel} value={filter} options={[{ value: 'all', label: c.filters.all }, { value: 'unread', label: c.filters.unread }]} onChange={setFilter} /></div>
          <Button variant="secondary" disabled={busy || unread === 0} onClick={() => void markAll()}>{c.markAllRead}</Button>
        </div>
        {items === null ? <div className="p-4"><Loading /></div>
          : items.length === 0 ? <p className="p-4 text-base text-muted">{filter === 'unread' ? c.emptyUnread : c.empty}</p>
          : (
            <ul>
              {items.map((n) => (
                <li key={n.id} className={`${cardRow} flex gap-3`}>
                  <span aria-hidden="true" className={`mt-2 size-2 shrink-0 rounded-full ${DOT[n.severity] ?? DOT.info}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-base font-semibold">{n.title}</span>
                      <span className="sr-only">{c.severity[n.severity] ?? ''}</span>
                      {n.count > 1 && <span className="text-sm text-muted" title={c.repeatedTitle(n.count)}>{c.repeated(n.count)}</span>}
                    </div>
                    <p className="text-base">{n.body}</p>
                    <p className="text-sm text-muted">{when(n.updatedAt)}</p>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {n.data.requestId && <Link className="text-base" to={`/requests/${n.data.requestId}`}>{c.openPayment}</Link>}
                      {!n.readAt && <Button variant="ghost" onClick={() => void markOne(n)}>{c.markRead}</Button>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </>
  );
}
