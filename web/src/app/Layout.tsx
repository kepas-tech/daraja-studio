import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Nav } from './Nav';
import { useSession } from './session';
import { FingerprintCard } from './FingerprintCard';
import { LockScreen } from './LockScreen';
import { useLockWatchers } from './useLockWatchers';
import { api } from '../api/client';
import { CriticalAlert } from '../components/CriticalAlert';
import { Flash } from '../components/Flash';
import { Icon } from '../components/Icon';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';
import logo from '../assets/logo-long.png';

const item = 'flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-base text-ink hover:bg-page hover:no-underline';

/** One button on the right of the header: who you are, and everything about the account behind it. */
function AccountMenu() {
  const { person, org, refresh } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey); document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);
  const logout = async () => { setOpen(false); await api.post('/api/auth/logout'); await refresh(); };
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={copy.account.menu} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-base ${open ? 'border-line bg-page' : 'border-transparent hover:bg-page'}`}>
        <Icon name="account" className="size-5" />
        <span className="hidden sm:inline">{person?.display_name}</span>
        <Icon name="chevron-down" className="size-4 text-muted" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-72 overflow-hidden rounded-md border border-line bg-surface py-1 shadow-lg">
          {org && <div className="border-b border-line px-4 py-3"><div className="truncate text-base font-semibold">{org.name}</div><div className="text-sm text-muted">{org.shortcode ? `${copy.org.numberLine(org.shortcodeKind, org.shortcode)} · ` : ''}{copy.org.envLine[org.environment]}</div></div>}
          {person?.is_owner && <Link to="/account" role="menuitem" className={item} onClick={() => setOpen(false)}><Icon name="cog" className="size-4 text-muted" />{copy.account.organisation}</Link>}
          <Link to="/account/password" role="menuitem" className={item} onClick={() => setOpen(false)}><Icon name="confirm" className="size-4 text-muted" />{copy.account.changePassword}</Link>
          <button type="button" className={item} onClick={() => void logout()}><Icon name="logout" className="size-4 text-muted" />{copy.nav.logout}</button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { org, pinSet, pinLocked, modules } = useSession();
  useLockWatchers();
  // Brief 2, item 3: while the PIN is owed, the app is not on screen at all — no header, no page,
  // nothing half-typed for a hand that is not the owner's to finish.
  if (pinSet && pinLocked) return <LockScreen />;
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface text-ink">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <NavLink to="/" className="inline-flex shrink-0 items-center text-ink hover:no-underline">
            {/* The logo carries the studio's name, so the name is the image's own alternative text.
                The source is 530 × 160 and it is drawn 44px tall, so a high-density screen has more
                pixels than it needs rather than fewer. */}
            <img src={logo} alt={copy.appName} className="h-11 w-auto" />
          </NavLink>
          {/* Which studio this is, on every page, is the left navigation's job. What the header adds
              is the mode: the tier the switched-on parts actually equal, read from the module state,
              so a change made by hand reads as Custom rather than naming a tier the studio is not. */}
          <span data-testid="mode-tag" className="shrink-0 rounded-full border border-line px-2 py-0.5 text-xs font-medium text-muted">{copy.modeTag(modules.tier)}</span>
        </div>
        <AccountMenu />
      </header>
      {/* The header and the sidebar stay put; only the content column scrolls, and only when it
          needs to. min-h-0 lets the flex children shrink below their content height. */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Nav />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl p-4 md:p-6">
            {/* A suspended organisation keeps every read; only its writes are refused. */}
            {org?.status === 'suspended' && <Flash tone="danger" role="status" className="mb-6">{copy.org.suspended}</Flash>}
            {/* Round 3, phase D-8: an unread critical alert stands on every page, until it is read. */}
            <CriticalAlert />
            {/* Brief 2, item 5b: the one-time offer of a fingerprint, in the page and never a dialog. */}
            <FingerprintCard />
            <Outlet />
          </div>
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
