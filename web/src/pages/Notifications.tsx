import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { notificationsChanged } from '../api/notifications';
import * as push from '../api/push';
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
/** Feature 12: what the device card can show. 'hidden' is the no-keys state, which shows nothing. */
type PushState = 'checking' | 'hidden' | 'unsupported' | 'off' | 'on' | 'denied';

/** What happened while nobody was looking. Sentences, with the amount and the name already in them. */
export function Notifications() {
  const c = copy.notifications;
  const cp = c.push;
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

  // Feature 12. What this browser can do is a fact about the browser; what this deployment can do
  // is the server's answer. Both are asked once, when the page opens.
  const [pushState, setPushState] = useState<PushState>('checking');
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const answer = await push.key();
        if (!alive) return;
        if (!answer.configured || !answer.publicKey) { setPushState('hidden'); return; }
        if (!push.supported()) { setPushState('unsupported'); return; }
        if (push.permission() === 'denied') { setPushState('denied'); return; }
        setPushKey(answer.publicKey);
        setPushState((await push.subscribedHere()) ? 'on' : 'off');
      } catch {
        // The card is a convenience. A read that fails hides it; the inbox itself is unaffected.
        if (alive) setPushState('hidden');
      }
    })();
    return () => { alive = false; };
  }, []);

  const turnOn = async () => {
    if (!pushKey) return;
    setPushBusy(true);
    try {
      const answer = await push.turnOn(pushKey);
      setPushState(answer === 'on' ? 'on' : 'denied');
      if (answer === 'on') toast.success(cp.turnedOn);
    } catch (e) { setErr(explainApiError(e)); } finally { setPushBusy(false); }
  };
  const turnOff = async () => {
    setPushBusy(true);
    try { await push.turnOff(); setPushState('off'); toast.success(cp.turnedOff); }
    catch (e) { setErr(explainApiError(e)); } finally { setPushBusy(false); }
  };
  const sendTest = async () => {
    setPushBusy(true);
    try { const r = await push.sendTest(); toast.success(cp.testSent(r.sent, r.failed)); }
    catch (e) { setErr(explainApiError(e)); } finally { setPushBusy(false); }
  };

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
      {pushState !== 'checking' && pushState !== 'hidden' && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-base font-semibold">{cp.title}</p>
              <p className="text-base text-muted">
                {pushState === 'on' ? cp.on : pushState === 'denied' ? cp.denied : pushState === 'unsupported' ? cp.unsupported : cp.intro}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {pushState === 'off' && <Button disabled={pushBusy} onClick={() => void turnOn()}>{cp.enable}</Button>}
              {pushState === 'on' && (
                <>
                  <Button variant="secondary" disabled={pushBusy} onClick={() => void sendTest()}>{cp.test}</Button>
                  <Button variant="ghost" disabled={pushBusy} onClick={() => void turnOff()}>{cp.disable}</Button>
                </>
              )}
            </div>
          </div>
        </Card>
      )}
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
                      {typeof n.data.href === 'string' && <Link className="text-base" to={n.data.href}>{c.openOperators}</Link>}
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
