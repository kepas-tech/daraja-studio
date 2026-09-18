import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { notificationsChanged } from '../api/notifications';
import type { NotificationPage, NotificationView } from '../api/types';
import { BUZZ, buzz } from '../app/haptics';
import { Button } from './Button';
import { Flash } from './Flash';
import { useToast } from './Toast';
import { copy } from '../copy/en';

/**
 * Round 3, phase D-8: an unread critical alert makes itself known on every page.
 *
 * The server reminds about it every fifteen minutes — a push to every device, and an event on the
 * stream — and this is what an open Studio tab does with that: it buzzes, and it keeps the line on
 * screen until somebody presses that they have read it. Reading it is what stops the reminders, so
 * the button is the point of the whole thing.
 */
export function CriticalAlert() {
  const toast = useToast();
  const [alert, setAlert] = useState<NotificationView | null>(null);

  /** The worst unread line, or none. The inbox is the single source; nothing is counted here. */
  const read = useCallback(() => api.get<NotificationPage>('/api/notifications?filter=unread&limit=25')
    .then((p) => p.items.find((n) => n.severity === 'critical') ?? null)
    .catch(() => null), []);
  const load = useCallback(() => { void read().then(setAlert); }, [read]);
  useEffect(load, [load]);

  // The reminder itself: a buzz on the device, and the line re-read so a line read on another
  // screen disappears here too. `notification.created` is here for the first critical of a session.
  useEvents(useCallback((e) => {
    if (e.type !== 'notification.buzz' && e.type !== 'notification.created') return;
    void read().then((worst) => {
      setAlert(worst);
      if (worst) buzz(BUZZ.alarm);
    });
  }, [read]), true, load);

  const markRead = async () => {
    if (!alert) return;
    await api.post(`/api/notifications/${alert.id}/read`);
    setAlert(null);
    notificationsChanged();
    toast.success(copy.notifications.critical.readDone);
  };

  if (!alert) return null;
  return (
    <Flash tone="danger" role="alert" data-testid="critical-alert" className="mb-6">
      <p className="font-semibold">{copy.notifications.critical.title}</p>
      <p>{alert.title}{alert.count > 1 ? ' ' + copy.notifications.repeated(alert.count) : ''} — {alert.body}</p>
      <p className="text-sm">{copy.notifications.critical.lead}</p>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="button" variant="secondary" onClick={() => void markRead()}>{copy.notifications.critical.read}</Button>
        <Link to="/notifications" className="text-base">{copy.notifications.title}</Link>
      </div>
    </Flash>
  );
}
