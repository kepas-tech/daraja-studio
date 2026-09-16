import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Settings } from '../pages/Settings';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

class FakeEventSource { addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

const emptySlot = {
  shortcode: null,
  consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null,
  passkey: { saved: false, last4: null }, passkeyProven: false, cert: { saved: false, last4: null },
  operators: [], ready: { creds: false, operator: false },
  b2cApi: { setting: 'auto' as const, detected: null, detectedAt: null },
};
const view = {
  mode: 'production',
  environments: { sandbox: emptySlot, production: { ...emptySlot, shortcode: '700111', ready: { creds: true, operator: true } } },
  org: { name: 'ACME TRADERS', nominatedNumber: '254700000000', notificationPhone: '254700000000' },
  stkEnabled: false, publicUrl: 'https://x', publicVerifiedAt: null, httpsSeen: false,
  allowlist: ['1.1.1.1'], setupCompletedAt: 'x',
  sendCategories: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }], approvalThresholdCents: 0,
  uses: { payOut: true, collect: true, stk: false },
};

function mockFetch(handle: (url: string, method: string, init?: RequestInit) => Response, data: unknown = view) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify(data), { status: 200 });
    if (url === '/api/invoices/settings') return new Response(JSON.stringify({ optedIn: false, remindersOn: false, email: null, phone: null }), { status: 200 });
    return handle(url, method, init);
  });
}
async function renderAndWait() {
  render(<MemoryRouter><ToastHost /><Settings /></MemoryRouter>);
  await waitFor(() => expect(screen.getByTestId('setting-public-url')).toBeInTheDocument());
}
const none = (url: string, method: string) => { throw new Error(`unexpected fetch ${method} ${url}`); };

// Settings is how Studio behaves. The organisation itself (name, mode, numbers, Safaricom
// credentials, operators, people) lives on the Organisation page since 0.15.0.
describe('Settings', () => {
  it('shows appearance, the public address, categories, approvals, invoices and Advanced, and nothing about the organisation', async () => {
    vi.stubGlobal('fetch', mockFetch(none));
    await renderAndWait();
    for (const text of [copy.settings.appearance.title, copy.settings.publicUrl, copy.settings.categories.title, copy.settings.approvals.title, copy.settings.invoices.title, copy.settings.advanced]) {
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    }
    expect(screen.queryByTestId('setting-org')).toBeNull();
    expect(screen.queryByTestId('setting-daraja')).toBeNull();
    expect(screen.queryByTestId('setting-passkey')).toBeNull();
    expect(screen.queryByText(copy.settings.operatorsTitle)).toBeNull();
    expect(screen.queryByText(copy.settings.mode.title)).toBeNull();
  });

  it('folds the B2C version, the callback addresses and the callback secret under Advanced, closed by default', async () => {
    vi.stubGlobal('fetch', mockFetch(none));
    await renderAndWait();
    const advanced = screen.getByTestId('advanced') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(within(advanced).getByTestId('setting-b2c-api')).toBeInTheDocument();
    expect(within(advanced).getByTestId('setting-allowlist')).toHaveTextContent('1.1.1.1');
    expect(within(advanced).getByText(copy.settings.organisation.callbackSecret)).toBeInTheDocument();
  });

  it('reveals the callback secret behind the password dialog, and hides it again', async () => {
    let revealed: unknown = null;
    vi.stubGlobal('fetch', mockFetch((url, method, init) => {
      if (url === '/api/settings/install-secret/reveal' && method === 'POST') { revealed = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ secret: 'top-secret-value' }), { status: 200 }); }
      throw new Error(`unexpected ${method} ${url}`);
    }));
    await renderAndWait();
    fireEvent.click(screen.getByRole('button', { name: copy.settings.revealSecret }));
    fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'owner-password' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    expect(await screen.findByText('top-secret-value')).toBeInTheDocument();
    expect(revealed).toEqual({ password: 'owner-password' });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.hideSecret }));
    await waitFor(() => expect(screen.queryByText('top-secret-value')).not.toBeInTheDocument());
  });

  it('saves the public address after the password and tests it', async () => {
    let put: unknown = null;
    vi.stubGlobal('fetch', mockFetch((url, method, init) => {
      if (url === '/api/settings/public-url' && method === 'PUT') { put = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); }
      if (url === '/api/settings/public-url/test' && method === 'POST') return new Response(JSON.stringify({ ok: true, detail: 'Reached.' }), { status: 200 });
      throw new Error(`unexpected ${method} ${url}`);
    }));
    await renderAndWait();
    const row = screen.getByTestId('setting-public-url');
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.change }));
    fireEvent.change(within(row).getByLabelText(copy.setup.publicUrl.field, { exact: false }), { target: { value: 'https://pay.example.co.ke' } });
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'owner-password' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(put).toEqual({ url: 'https://pay.example.co.ke', password: 'owner-password' }));
    fireEvent.click(within(row).getByRole('button', { name: copy.setup.publicUrl.test }));
    expect(await screen.findByText('Reached.')).toBeInTheDocument();
  });
});
