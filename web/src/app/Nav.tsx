import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { useSession } from './session';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { NOTIFICATIONS_CHANGED } from '../api/notifications';
import { Icon } from '../components/Icon';
import { StatusPill } from '../components/StatusPill';
import { copy, type NavEntry } from '../copy/en';

/**
 * The menu's three numbers: how many rows are waiting for a person (feature 5: held for a second
 * person, or never answered by Safaricom), whether approvals are on at all, and how many lines in
 * the inbox nobody has read. Any signed-in person may read all three; one stream serves them, and
 * they are read again on every reconnect, so a badge is never left stale by an event that arrived
 * while the stream was down.
 */
function useMenuCounts(): { approvals: { enabled: boolean }; waiting: number; unread: number } {
  // Approvals is shown until the answer says otherwise; the inbox starts empty.
  const [approvals, setApprovals] = useState({ enabled: true });
  const [waiting, setWaiting] = useState(0);
  const [unread, setUnread] = useState(0);
  const loadApprovals = useCallback(() => api.get<{ enabled: boolean }>('/api/approvals/count').then((r) => setApprovals({ enabled: !!r.enabled })).catch(() => {}), []);
  const loadWaiting = useCallback(() => api.get<{ badge: number }>('/api/waiting/count').then((r) => setWaiting(r.badge ?? 0)).catch(() => {}), []);
  const loadUnread = useCallback(() => api.get<{ unread: number }>('/api/notifications/count').then((r) => setUnread(r.unread ?? 0)).catch(() => {}), []);
  const loadAll = useCallback(() => { void loadApprovals(); void loadWaiting(); void loadUnread(); }, [loadApprovals, loadWaiting, loadUnread]);
  useEffect(() => { loadAll(); }, [loadAll]);
  useEvents(useCallback((e) => {
    if (e.type === 'request.updated') { void loadApprovals(); void loadWaiting(); }
    if (e.type === 'notification.created') void loadUnread();
  }, [loadApprovals, loadWaiting, loadUnread]), typeof EventSource !== 'undefined', loadAll);
  // Reading the inbox is not an event the server sends (nothing moved); the page says so on the window.
  useEffect(() => {
    const onChanged = () => void loadUnread();
    window.addEventListener(NOTIFICATIONS_CHANGED, onChanged);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, onChanged);
  }, [loadUnread]);
  return { approvals, waiting, unread };
}

function Item({ e, onPick, badge }: { e: NavEntry; onPick: () => void; badge?: number }) {
  return (
    <li>
      <NavLink to={e.path} end={e.path === '/'} onClick={onPick} title={e.safaricom ?? undefined} className={({ isActive }) => `flex min-h-10 items-center gap-3 border-l-2 px-3 py-2 text-base text-ink hover:no-underline ${isActive ? 'border-brand bg-surface font-semibold' : 'border-transparent hover:bg-surface/70'}`}>
        <Icon name={e.icon} className={`size-4 ${e.available ? '' : 'text-muted'}`} />
        <span className={`min-w-0 truncate ${e.available ? '' : 'text-muted'}`}>{e.label}</span>
        {e.safaricom && <span className="sr-only">{e.safaricom}</span>}
        {!e.available && <StatusPill kind="muted">{copy.comingSoon.badge}</StatusPill>}
        {!!badge && <StatusPill kind="warn">{badge}</StatusPill>}
      </NavLink>
    </li>
  );
}

const heading = 'px-3 pt-5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted';

export function Nav() {
  const { org, person } = useSession();
  // The open state is ours, not the browser's: a <details> element is content-hidden when closed in
  // current Chrome, so its links were never painted or clickable. Owning the state keeps the
  // open/closed decision somewhere a test can assert (see nav.test.tsx).
  const [open, setOpen] = useState(false);
  const pick = () => setOpen(false);
  const live = copy.nav.filter((e) => e.available);
  const { approvals, waiting, unread } = useMenuCounts();
  // Waiting fills while Settings › Approvals is on, or while a row waits for a person (held, or
  // never answered by Safaricom); hidden only when there is nothing to do there at all. Who did
  // what is the owner's own record of who changed what, so nobody else is offered the link.
  const shown = (e: NavEntry) =>
    (e.key !== 'approvals' || approvals.enabled || waiting > 0) &&
    (e.key !== 'who-did-what' || !!person?.is_owner);
  const badge = (e: NavEntry) => (e.key === 'approvals' ? waiting : e.key === 'notifications' ? unread : undefined);
  return (
    <nav aria-label={copy.app.navLabel} className="w-full shrink-0 border-b border-line bg-page md:w-60 md:overflow-y-auto md:border-r md:border-b-0">
      <button type="button" aria-expanded={open} aria-controls="nav-entries" onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-4 text-base font-semibold md:hidden">
        <Icon name={open ? 'close' : 'menu'} className="size-5" />
        <span>{copy.nav.menu}</span>
      </button>
      <ul id="nav-entries" className={`${open ? 'block' : 'hidden'} pb-4 md:block`}>
        {org && <li className="px-3 pt-4 pb-2" title={org.name}><span className="block truncate text-sm font-semibold">{org.name}</span><span className="block text-xs text-muted">{org.shortcode ? `${copy.org.numberLine(org.shortcodeKind, org.shortcode)} · ` : ''}{copy.org.envLine[org.environment]}</span></li>}
        {live.filter((e) => e.group === 'home').map((e) => <Item key={e.key} e={e} onPick={pick} badge={badge(e)} />)}
        {(['in', 'out', 'manage'] as const).map((g) => (
          <li key={g}>
            <div className={heading}>{copy.nav.groups[g]}</div>
            <ul>{live.filter((e) => e.group === g && !e.advanced && shown(e)).map((e) => <Item key={e.key} e={e} onPick={pick} badge={badge(e)} />)}</ul>
          </li>
        ))}
        <li className="mt-4 border-t border-line pt-2"><ul>{live.filter((e) => e.group === 'help').map((e) => <Item key={e.key} e={e} onPick={pick} />)}</ul></li>
      </ul>
    </nav>
  );
}
