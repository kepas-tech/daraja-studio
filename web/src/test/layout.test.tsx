import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Layout } from '../app/Layout';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('Layout log out', () => {
  it('renders a Log out button that logs out and refreshes the session', async () => {
    let loggedOut = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: null }), { status: 200 });
      if (url === '/api/auth/me') {
        if (loggedOut) return new Response(JSON.stringify({ error: { code: 'not_logged_in', message: 'x' } }), { status: 401 });
        return new Response(JSON.stringify({
          person: { id: '1', username: 'owner', display_name: 'Host Owner', is_owner: true, must_change_password: false },
          csrf: 'c', permissions: [],
        }), { status: 200 });
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
