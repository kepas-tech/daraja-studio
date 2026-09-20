import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Layout } from '../app/Layout';
import { copy } from '../copy/en';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const me = {
  person: { id: '1', username: 'owner', display_name: 'Host Owner', is_owner: true, must_change_password: false },
  csrf: 'c', permissions: [],
  org: {
    id: 'o1', name: 'KEPAS TECHNOLOGIES', status: 'verified', environment: 'production',
    isHost: true, suspendReason: null, shortcode: null, shortcodeKind: null,
  },
};

describe('Layout log out', () => {
  it('renders a Log out button that logs out and refreshes the session', async () => {
    let loggedOut = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: null }), { status: 200 });
      if (url === '/api/auth/me') {
        if (loggedOut) return new Response(JSON.stringify({ error: { code: 'not_logged_in', message: 'x' } }), { status: 401 });
        return new Response(JSON.stringify(me), { status: 200 });
      }
      if (url === '/api/auth/logout' && init?.method === 'POST') { loggedOut = true; return new Response(null, { status: 204 }); }
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><SessionProvider><Layout /></SessionProvider></MemoryRouter>);
    await screen.findByText('Host Owner');

    fireEvent.click(screen.getByRole('button', { name: copy.account.menu }));
    // Delete this studio left the header menu in 0.13.1; it lives on the Account page only.
    expect(screen.queryByRole('menuitem', { name: copy.account.deleteButton })).toBeNull();
    expect(screen.getByRole('menuitem', { name: copy.account.organisation })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.nav.logout }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' })));
    // refresh() re-runs the session bootstrap, and /api/auth/me now 401s post-logout.
    await waitFor(() => expect(screen.queryByText('Host Owner')).not.toBeInTheDocument());
  });
});

describe('Layout studio name', () => {
  it('says which studio the person is in, in the top bar, without opening anything', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: null }), { status: 200 });
      if (url === '/api/auth/me') return new Response(JSON.stringify(me), { status: 200 });
      throw new Error('unexpected fetch ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<MemoryRouter><SessionProvider><Layout /></SessionProvider></MemoryRouter>);
    await screen.findByText('Host Owner');

    // The header itself, on every page the layout wraps, and not only inside the account menu.
    const header = screen.getByRole('banner');
    expect(within(header).getByText('KEPAS TECHNOLOGIES')).toBeInTheDocument();
    // Quiet, not a heading: the product's own name is still the only heading in it.
    expect(within(header).queryByRole('heading')).toBeNull();
  });
});
