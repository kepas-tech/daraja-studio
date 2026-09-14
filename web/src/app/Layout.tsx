import { Outlet } from 'react-router';
import { Nav } from './Nav';
import { useSession } from './session';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { StatusPill } from '../components/StatusPill';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

export function Layout() {
  const { person, org, refresh } = useSession();
  const logout = async () => { await api.post('/api/auth/logout'); await refresh(); };
  return (
    // PB3-F3: the shell stacks on a narrow screen and sits side by side from md upwards. min-w-0
    // lets the content column shrink below its content's intrinsic width instead of widening the
    // page, and every row here wraps rather than pushing past the viewport.
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900 md:flex-row dark:bg-gray-900 dark:text-gray-100">
      <Nav />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-200 bg-white px-4 py-3 md:px-6 dark:border-gray-800 dark:bg-gray-950">
          {/* The wordmark is full-colour on a transparent background, so a small white backing
              keeps it legible in dark mode too — the same treatment a coloured logo gets on any
              dark dashboard chrome. */}
          <span className="inline-flex items-center rounded-md bg-white px-2 py-1">
            <img src="/logo-long.png" alt={copy.appName} className="h-6 w-auto md:h-7" />
          </span>
          <div className="flex flex-wrap items-center gap-3">
            {org && <span className="text-sm font-medium">{org.name}</span>}
            {org && (
              <span className="flex flex-col items-start leading-tight">
                <StatusPill kind={org.environment === 'production' ? 'ok' : 'warn'}>{copy.org.badge[org.environment]}</StatusPill>
                <span className="text-xs text-gray-500">{copy.org.badgeSafaricom[org.environment]}</span>
              </span>
            )}
            <span className="text-sm text-gray-600 dark:text-gray-400">{person?.display_name}</span>
            <Button variant="secondary" onClick={() => void logout()}>{copy.nav.logout}</Button>
          </div>
        </header>
        <main className="mx-auto max-w-4xl p-4 md:p-6">
          {/* Spec 6.2: a suspended organisation keeps every read; only its writes are refused. */}
          {org?.status === 'suspended' && (
            <p role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30">{copy.org.suspended}</p>
          )}
          <Outlet />
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
