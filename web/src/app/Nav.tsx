import { useCallback, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useSession } from './session';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { Icon } from '../components/Icon';
import { StatusPill } from '../components/StatusPill';
import { copy, type NavEntry } from '../copy/en';

/** M4: how many sends wait for a second person; any signed-in person may read it. */
function useApprovalsCount(): number {
  const [n, setN] = useState(0);
  const load = useCallback(() => api.get<{ count: number }>('/api/approvals/count').then((r) => setN(r.count)).catch(() => {}), []);
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
  const advanced = live.filter((e) => e.advanced);
  const waiting = useApprovalsCount();
  // Advanced stays folded unless the person opened it (remembered) or is on one of its pages.
  const { pathname } = useLocation();
  const onAdvancedPage = advanced.some((e) => pathname === e.path || pathname.startsWith(`${e.path}/`));
  const [advancedPref, setAdvancedPref] = useState<boolean>(() => { try { return localStorage.getItem('studio.nav.advanced') === 'open'; } catch { return false; } });
  const advancedOpen = advancedPref || onAdvancedPage;
  const setAdvanced = (open: boolean) => { setAdvancedPref(open); try { localStorage.setItem('studio.nav.advanced', open ? 'open' : 'closed'); } catch { /* private window */ } };
  return (
    <nav aria-label={copy.app.navLabel} className="w-full shrink-0 border-b border-line bg-page md:w-60 md:overflow-y-auto md:border-r md:border-b-0">
      <button type="button" aria-expanded={open} aria-controls="nav-entries" onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-4 text-base font-semibold md:hidden">
        <Icon name={open ? 'close' : 'menu'} className="size-5" />
        <span>{copy.nav.menu}</span>
      </button>
      <ul id="nav-entries" className={`${open ? 'block' : 'hidden'} pb-4 md:block`}>
        {org && <li className="px-3 pt-4 pb-2" title={org.name}><span className="block truncate text-sm font-semibold">{org.name}</span><span className="block text-xs text-muted">{copy.org.envLine[org.environment]}</span></li>}
        {live.filter((e) => e.group === 'home').map((e) => <Item key={e.key} e={e} onPick={pick} />)}
        {(['in', 'out', 'manage'] as const).map((g) => (
          <li key={g}>
            <div className={heading}>{copy.nav.groups[g]}</div>
            <ul>{live.filter((e) => e.group === g && !e.advanced).map((e) => <Item key={e.key} e={e} onPick={pick} badge={e.key === 'approvals' ? waiting : undefined} />)}</ul>
          </li>
        ))}
        {advanced.length > 0 && (
          <li className="pt-4">
            <button type="button" aria-expanded={advancedOpen} aria-controls="nav-advanced" onClick={() => setAdvanced(!advancedOpen)} className="flex min-h-10 w-full cursor-pointer items-center gap-3 px-3 text-left text-sm font-semibold text-muted hover:text-ink">
              <Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} className="size-4" />
              <span>{copy.nav.advanced}</span>
            </button>
            <ul id="nav-advanced" className={advancedOpen ? 'block' : 'hidden'}>
              <li className="px-3 pb-1 text-xs text-muted">{copy.nav.advancedHint}</li>
              {(['in', 'out'] as const).filter((g) => advanced.some((e) => e.group === g)).map((g) => (
                <li key={g}>
                  <div className={`${heading} pt-2`}>{copy.nav.groups[g]}</div>
                  <ul>{advanced.filter((e) => e.group === g).map((e) => <Item key={e.key} e={e} onPick={pick} />)}</ul>
                </li>
              ))}
            </ul>
          </li>
        )}
        <li className="mt-4 border-t border-line pt-2"><ul>{live.filter((e) => e.group === 'help').map((e) => <Item key={e.key} e={e} onPick={pick} />)}</ul></li>
      </ul>
    </nav>
  );
}
