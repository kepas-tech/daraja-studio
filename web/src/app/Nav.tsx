import { useState } from 'react';
import { NavLink } from 'react-router';
import * as Icons from 'react-feather';
import { useSession } from './session';
import { copy } from '../copy/en';

export function Nav() {
  const { hostAdmin } = useSession();
  // Spec 6.1: the host console exists only for the people the server says run this service.
  // Appended rather than kept in copy.nav, so a tenant's navigation is byte-for-byte what it was.
  const entries = hostAdmin ? [...copy.nav, copy.hostNavEntry] : copy.nav;
  // The open state is ours, not the browser's. This was a <details>/<summary> pair: current Chrome
  // treats a closed <details> as content-hidden, so its children were laid out and then never
  // painted or hit-tested, whatever the list's own display said. From md upwards the summary was
  // hidden too, so the whole desktop sidebar was invisible with no control that could open it.
  // jsdom does not implement that behaviour, which is why the suite never saw it; owning the state
  // puts the open/closed decision somewhere a test can actually assert.
  const [open, setOpen] = useState(false);
  return (
    // PB3-F3: a phone gets one menu button instead of a 256-pixel sidebar, so the page fits the
    // viewport without sideways scrolling. From md upwards this is the same sidebar as before.
    <nav aria-label={copy.app.navLabel} className="w-full shrink-0 border-b border-gray-200 bg-white md:w-64 md:border-b-0 md:border-r dark:border-gray-800 dark:bg-gray-950">
      <button type="button" aria-expanded={open} aria-controls="nav-entries" onClick={() => setOpen((v) => !v)} className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-base font-medium md:hidden">
        <Icons.Menu size={20} strokeWidth={1.5} className="shrink-0" aria-hidden />
        <span>{copy.nav.menu}</span>
      </button>
      <ul id="nav-entries" className={`${open ? 'block' : 'hidden'} space-y-1 p-3 md:block`}>
        {entries.map((e) => {
          const Icon = (Icons as unknown as Record<string, Icons.Icon>)[e.icon] ?? Icons.Circle;
          return (
            <li key={e.key}>
              <NavLink to={e.path} end={e.path === '/'} onClick={() => setOpen(false)} className={({ isActive }) => `flex items-start gap-3 rounded-lg px-3 py-2 text-base ${isActive ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100' : 'text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-900'}`}>
                <Icon size={20} strokeWidth={1.5} className="mt-0.5 shrink-0" aria-hidden />
                <span className="flex flex-col"><span>{e.label}</span>{e.safaricom && <span className="text-xs text-gray-500">{e.safaricom}</span>}{!e.available && <span className="mt-1 text-xs font-medium text-gray-500 dark:text-gray-400">{copy.comingSoon.badge}</span>}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
