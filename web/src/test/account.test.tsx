import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Account } from '../pages/Account';
import { Settings } from '../pages/Settings';
import type { ReactNode } from 'react';
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
    production: slot({ shortcode: '700111', credsVerifiedAt: '2026-09-07T07:00:00Z', ready: { creds: true, operator: true } }),
  },
  org: { name: 'ACME TRADERS', nominatedNumber: '254700000000', notificationPhone: '254700000000' },
  stkEnabled: false, publicUrl: 'https://darajastudio.com', publicVerifiedAt: '2026-09-08T04:00:00Z', httpsSeen: true,
  allowlist: ['196.201.214.200'], setupCompletedAt: '2026-09-01T09:00:00Z',
  sendCategories: [], approvalThresholdCents: 0,
};

function mount(handlers: (url: string, method: string, init?: RequestInit) => Response, data: unknown = view, page: ReactNode = <Account />) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/setup/status') return new Response(JSON.stringify({ mode: 'hosted', hosted: { signupOpen: true, egressIps: ['192.0.2.10'] }, needsOwner: false, completed: true, step: 'done' }), { status: 200 });
    if (url === '/api/auth/me') {
      return new Response(JSON.stringify({
        person: { id: 'p1', username: 'amina@example.co.ke', display_name: 'Amina', is_owner: true, must_change_password: false },
        csrf: 'c', permissions: [],
        org: { id: 'o1', name: 'ACME TRADERS', status: 'verified', environment: 'production', isHost: true, suspendReason: null, createdAt: '2026-09-01T08:00:00Z', verifiedAt: '2026-09-01T09:05:00Z' },
      }), { status: 200 });
    }
    if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify(data), { status: 200 });
    return handlers(url, method, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  render(<MemoryRouter><SessionProvider><ToastHost />{page}</SessionProvider></MemoryRouter>);
  return fetchMock;
}

// The organisation card (name, contacts, verification, public address, callback secret) lives at the
// top of Settings since 0.13.1, so the business name is found where a person expects to change it.
describe('Settings › Organisation', () => {
  it('names the organisation, when it signed up and when Safaricom verified it', async () => {
    mount(() => { throw new Error('no other call expected'); }, view, <Settings />);
    await screen.findByText(copy.settings.organisation.title);
    expect(screen.getAllByText('ACME TRADERS').length).toBeGreaterThan(0);
    expect(screen.getByText(copy.org.signedUp, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(copy.org.verifiedOn, { exact: false })).toBeInTheDocument();
  });

  it('shows what Safaricom has verified in each environment', async () => {
    mount(() => { throw new Error('no other call expected'); }, view, <Settings />);
    await screen.findByText(copy.settings.organisation.title);
    expect(screen.getByTestId('verification-production')).toHaveTextContent(copy.settings.organisation.verifiedWith);
    expect(screen.getByTestId('verification-production')).toHaveTextContent('700111');
    expect(screen.getByTestId('verification-sandbox')).toHaveTextContent(copy.settings.organisation.notVerifiedWith);
  });

  it('links to the People page', async () => {
    mount(() => { throw new Error('no other call expected'); }, view, <Settings />);
    expect(await screen.findByRole('link', { name: copy.settings.organisation.peopleLink })).toHaveAttribute('href', '/people');
  });

  it('reveals the callback secret behind the password dialog, and hides it again', async () => {
    let revealed: unknown = null;
    mount((url, method, init) => {
      if (url === '/api/settings/install-secret/reveal' && method === 'POST') { revealed = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ secret: 'top-secret-value' }), { status: 200 }); }
      throw new Error(`unexpected ${method} ${url}`);
    }, view, <Settings />);
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
    mount(() => { throw new Error('no other call expected'); }, view, <Settings />);
    await screen.findByText(copy.settings.organisation.title);
    expect(screen.queryByText(copy.settings.advanced)).not.toBeInTheDocument();
  });

});

describe('Account', () => {
  it('lists both shortcodes and saves one after the password', async () => {
    let put: unknown = null;
    mount((url, method, init) => {
      if (url === '/api/settings/environments/sandbox/shortcode' && method === 'PUT') { put = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ verifiedName: null, verifyError: null }), { status: 200 }); }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const row = await screen.findByTestId('shortcode-sandbox');
    expect(row).toHaveTextContent('174379');
    expect(screen.getByTestId('shortcode-production')).toHaveTextContent('700111');
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.change }));
    fireEvent.change(within(row).getByLabelText(copy.settings.shortcode.label), { target: { value: '600000' } });
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'owner-password' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(put).toEqual({ shortcode: '600000', password: 'owner-password' }));
  });

  it('switching to production asks for the shortcode; a mismatch toasts, a match switches', async () => {
    let attempt = 0;
    mount((url, method) => {
      if (url === '/api/settings/mode' && method === 'PUT') {
        attempt += 1;
        if (attempt === 1) return new Response(JSON.stringify({ error: { code: 'confirm_shortcode', message: 'Type your shortcode exactly to switch to production.' } }), { status: 400 });
        return new Response(JSON.stringify({ mode: 'production', ready: { creds: true, operator: true } }), { status: 200 });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }, { ...view, mode: 'sandbox' });
    await screen.findByText(copy.settings.mode.title);
    fireEvent.click(screen.getByLabelText(copy.settings.mode.production, { exact: false }));
    fireEvent.change(screen.getByLabelText(copy.settings.mode.confirmShortcode), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.confirm.switchMode('production') }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Type your shortcode exactly to switch to production.'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.settings.mode.confirmShortcode), { target: { value: '700111' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.confirm.switchMode('production') }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(copy.settings.mode.switched('production')));
  });

  it('deleting the studio needs the organisation name typed exactly, then posts the wipe', async () => {
    let wiped: unknown = null;
    mount((url, method, init) => {
      if (url === '/api/org/wipe' && method === 'POST') { wiped = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); }
      if (url === '/api/auth/logout') return new Response(null, { status: 204 });
      throw new Error(`unexpected ${method} ${url}`);
    });
    await screen.findByText(copy.account.deleteTitle);
    fireEvent.click(screen.getByRole('button', { name: copy.account.deleteButton }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(copy.confirm.yourPassword), { target: { value: 'owner-password' } });
    expect(within(dialog).getByRole('button', { name: copy.confirm.confirm })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(copy.account.typeName('ACME TRADERS')), { target: { value: 'APIONE' } });
    expect(within(dialog).getByRole('button', { name: copy.confirm.confirm })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(copy.account.typeName('ACME TRADERS')), { target: { value: 'ACME TRADERS' } });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(wiped).toEqual({ confirmName: 'ACME TRADERS', password: 'owner-password' }));
  });
});
