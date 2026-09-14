import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Settings } from '../pages/Settings';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

afterEach(() => cleanup());

const slot = (over: object = {}) => ({
  shortcode: null,
  consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null,
  passkey: { saved: false, last4: null }, cert: { saved: false, last4: null },
  operators: [], ready: { creds: false, operator: false },
  b2cApi: { setting: 'auto', detected: null, detectedAt: null },
  ...over,
});

const view = {
  mode: 'production',
  environments: {
    sandbox: slot({ shortcode: '174379' }),
    production: slot({ shortcode: '4052037', credsVerifiedAt: '2026-09-07T07:00:00Z', ready: { creds: true, operator: true } }),
  },
  org: { name: 'KEPAS TECHNOLOGIES', nominatedNumber: '254700000000', notificationPhone: '254700000000' },
  stkEnabled: false, publicUrl: 'https://darajastudio.com', publicVerifiedAt: '2026-09-08T04:00:00Z', httpsSeen: true,
  allowlist: ['196.201.214.200'], setupCompletedAt: '2026-09-01T09:00:00Z',
};

function mount(handlers: (url: string, method: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/setup/status') return new Response(JSON.stringify({ mode: 'hosted', hosted: { signupOpen: true, egressIps: ['192.0.2.10'] }, needsOwner: false, completed: true, step: 'done' }), { status: 200 });
    if (url === '/api/auth/me') {
      return new Response(JSON.stringify({
        person: { id: 'p1', username: 'nelson@kepas.co.ke', display_name: 'Nelson', is_owner: true, must_change_password: false },
        csrf: 'c', permissions: [],
        org: { id: 'o1', name: 'KEPAS TECHNOLOGIES', status: 'verified', environment: 'production', isHost: true, suspendReason: null, createdAt: '2026-09-01T08:00:00Z', verifiedAt: '2026-09-01T09:05:00Z' },
      }), { status: 200 });
    }
    if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify(view), { status: 200 });
    return handlers(url, method, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  render(<MemoryRouter><SessionProvider><ToastHost /><Settings /></SessionProvider></MemoryRouter>);
  return fetchMock;
}

describe('Settings › Organisation', () => {
  it('names the organisation, when it signed up and when Safaricom verified it', async () => {
    mount(() => { throw new Error('no other call expected'); });
    await screen.findByText(copy.settings.organisation.title);
    expect(screen.getAllByText('KEPAS TECHNOLOGIES').length).toBeGreaterThan(0);
    expect(screen.getByText(copy.org.signedUp, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(copy.org.verifiedOn, { exact: false })).toBeInTheDocument();
  });

  it('shows what Safaricom has verified in each environment', async () => {
    mount(() => { throw new Error('no other call expected'); });
    await screen.findByText(copy.settings.organisation.title);
    expect(screen.getByTestId('verification-production')).toHaveTextContent(copy.settings.organisation.verifiedWith);
    expect(screen.getByTestId('verification-production')).toHaveTextContent('4052037');
    expect(screen.getByTestId('verification-sandbox')).toHaveTextContent(copy.settings.organisation.notVerifiedWith);
  });

  it('links to the People page', async () => {
    mount(() => { throw new Error('no other call expected'); });
    expect(await screen.findByRole('link', { name: copy.settings.organisation.peopleLink })).toHaveAttribute('href', '/people');
  });

  it('reveals the callback secret behind the password dialog, and hides it again', async () => {
    let revealed: unknown = null;
    mount((url, method, init) => {
      if (url === '/api/settings/install-secret/reveal' && method === 'POST') { revealed = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ secret: 'top-secret-value' }), { status: 200 }); }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await screen.findByText(copy.settings.organisation.title);
    fireEvent.click(screen.getByRole('button', { name: copy.settings.revealSecret }));
    fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'owner-password' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    expect(await screen.findByText('top-secret-value')).toBeInTheDocument();
    // Task 6 minor 3: the reveal proves its step-up — the body carries the password.
    expect(revealed).toEqual({ password: 'owner-password' });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.hideSecret }));
    await waitFor(() => expect(screen.queryByText('top-secret-value')).not.toBeInTheDocument());
  });

  it('no longer has an Advanced card', async () => {
    mount(() => { throw new Error('no other call expected'); });
    await screen.findByText(copy.settings.organisation.title);
    expect(screen.queryByText(copy.settings.advanced)).not.toBeInTheDocument();
  });
});
