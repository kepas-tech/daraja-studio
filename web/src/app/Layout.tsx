import { NavLink, Outlet } from 'react-router';
import { Nav } from './Nav';
import { useSession } from './session';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { Flash } from '../components/Flash';
import { Icon } from '../components/Icon';
import { StatusPill } from '../components/StatusPill';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';
import mark from '../assets/logo-mark.png';

export function Layout() {
  const { person, org, refresh } = useSession();
  const logout = async () => { await api.post('/api/auth/logout'); await refresh(); };
  return (
    <div className="flex min-h-screen flex-col bg-surface text-ink">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2 md:px-6">
        <NavLink to="/" className="inline-flex items-center gap-3 text-ink hover:no-underline">
          <img src={mark} alt="" className="h-10 w-auto" />
          <span className="text-lg font-semibold">{copy.appName}</span>
        </NavLink>
        <div className="flex flex-wrap items-center gap-4">
          {org && <StatusPill kind={org.environment === 'production' ? 'ok' : 'muted'}>{copy.org.envLine[org.environment]}</StatusPill>}
          <span className="text-sm text-muted">{person?.display_name}</span>
          <Button variant="ghost" icon={<Icon name="logout" className="size-4" />} onClick={() => void logout()}>{copy.nav.logout}</Button>
        </div>
      </header>
      {/* Stacks on a phone, sits side by side from md upwards. min-w-0 lets the content column shrink
          below its content's intrinsic width instead of widening the page. */}
      <div className="flex flex-1 flex-col md:flex-row">
        <Nav />
        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-4xl p-4 md:p-6">
            {/* A suspended organisation keeps every read; only its writes are refused. */}
            {org?.status === 'suspended' && <Flash tone="danger" role="status" className="mb-6">{copy.org.suspended}</Flash>}
            <Outlet />
          </div>
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
