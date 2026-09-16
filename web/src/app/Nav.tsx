import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { useSession } from './session';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { Icon } from '../components/Icon';
import { StatusPill } from '../components/StatusPill';
import { copy, type NavEntry } from '../copy/en';

/** M4: how many sends wait for a second person, and whether approvals are on at all; any signed-in person may read it. */
function useApprovals(): { count: number; enabled: boolean } {
  const [n, setN] = useState<{ count: number; enabled: boolean }>({ count: 0, enabled: true }); // shown until the answer says otherwise
  const load = useCallback(() => api.get<{ count: number; enabled: boolean }>('/api/approvals/count').then((r) => setN({ count: r.count, enabled: !!r.enabled })).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'request.updated') void load(); }, [load]), typeof EventSource !== 'undefined');
  return n;
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
  const { org } = useSession();
  // The open state is ours, not the browser's: a <details> element is content-hidden when closed in
  // current Chrome, so its links were never painted or clickable. Owning the state keeps the
  // open/closed decision somewhere a test can assert (see nav.test.tsx).
  const [open, setOpen] = useState(false);
  const pick = () => setOpen(false);
  const live = copy.nav.filter((e) => e.available);
  const approvals = useApprovals();
  const waiting = approvals.count;
  // Waiting for approval only fills while Settings › Approvals is on; hidden otherwise, unless a send still waits from before.
  const shown = (e: NavEntry) => e.key !== 'approvals' || approvals.enabled || approvals.count > 0;
  return (
    <nav aria-label={copy.app.navLabel} className="w-full shrink-0 border-b border-line bg-page md:w-60 md:overflow-y-auto md:border-r md:border-b-0">
      <button type="button" aria-expanded={open} aria-controls="nav-entries" onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-4 text-base font-semibold md:hidden">
        <Icon name={open ? 'close' : 'menu'} className="size-5" />
        <span>{copy.nav.menu}</span>
      </button>
      <ul id="nav-entries" className={`${open ? 'block' : 'hidden'} pb-4 md:block`}>
        {org && <li className="px-3 pt-4 pb-2" title={org.name}><span className="block truncate text-sm font-semibold">{org.name}</span><span className="block text-xs text-muted">{org.shortcode ? `${copy.org.numberLine(org.shortcodeKind, org.shortcode)} · ` : ''}{copy.org.envLine[org.environment]}</span></li>}
        {live.filter((e) => e.group === 'home').map((e) => <Item key={e.key} e={e} onPick={pick} />)}
        {(['in', 'out', 'manage'] as const).map((g) => (
          <li key={g}>
            <div className={heading}>{copy.nav.groups[g]}</div>
            <ul>{live.filter((e) => e.group === g && !e.advanced && shown(e)).map((e) => <Item key={e.key} e={e} onPick={pick} badge={e.key === 'approvals' ? waiting : undefined} />)}</ul>
          </li>
        ))}
        <li className="mt-4 border-t border-line pt-2"><ul>{live.filter((e) => e.group === 'help').map((e) => <Item key={e.key} e={e} onPick={pick} />)}</ul></li>
      </ul>
    </nav>
  );
}
