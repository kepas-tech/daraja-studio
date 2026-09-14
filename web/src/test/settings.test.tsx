import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Settings } from '../pages/Settings';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

// jsdom has no EventSource; Settings subscribes to live updates via useEvents. This fake captures
// the registered listeners per event type so a test can simulate a server-sent event by calling
// `emit` on the most recently constructed instance.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, EventListener[]> = {};
  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent);
  }
}
vi.stubGlobal('EventSource', FakeEventSource);

// This file's vitest config does not set `test.globals: true`, so Testing
// Library's automatic per-test cleanup never registers — clean up explicitly.
afterEach(() => cleanup());

const emptySlot = {
  shortcode: null,
  consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null,
  passkey: { saved: false, last4: null }, cert: { saved: false, last4: null },
  operators: [], ready: { creds: false, operator: false },
  b2cApi: { setting: 'auto' as const, detected: null, detectedAt: null },
};
const sandboxSlot = { ...emptySlot };
const productionSlot = {
  ...emptySlot,
  shortcode: '4052037',
  consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: '2026-09-07T07:00:00Z',
  cert: { saved: true, last4: null },
  operators: [{ id: 'a', name: 'KEPAS', environment: 'production' as const, status: 'verified' as const, priority: 1, rotatedAt: '2026-09-02T00:00:00Z', lastProbeAt: null, lastError: null, expiresAt: '2026-12-01T00:00:00Z' }],
  ready: { creds: true, operator: true },
};
const view = {
  mode: 'production',
  environments: { sandbox: sandboxSlot, production: productionSlot },
  org: { name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' },
  stkEnabled: false, publicUrl: 'https://x', publicVerifiedAt: null, httpsSeen: false,
  allowlist: ['1.1.1.1'], setupCompletedAt: 'x',
  sendCategories: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }],
};
const sandboxView = { ...view, mode: 'sandbox' };

function mockFetch(handle: (url: string, method: string, init?: RequestInit) => Response, data: unknown = view) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify(data), { status: 200 });
    return handle(url, method, init);
  });
}

function renderSettings() {
  return render(<MemoryRouter><ToastHost /><Settings /></MemoryRouter>);
}

async function renderAndWait() {
  renderSettings();
  await waitFor(() => expect(screen.getByTestId('setting-shortcode')).toBeInTheDocument());
}

describe('Settings', () => {
  it('shows the active environment (production) with its saved creds and verified-at', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    expect(screen.getByText(copy.settings.envSettings('production'))).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByText(copy.settings.secret.savedEndsIn('4f2a'), { exact: false })).toBeInTheDocument();
    expect(screen.getByText(copy.settings.secret.verifiedAt('').trim(), { exact: false })).toBeInTheDocument();
  });

  it('shows the sandbox environment, with "Not set", when sandbox is the mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sandboxView), { status: 200 })));
    await renderAndWait();

    expect(screen.getByText(copy.settings.envSettings('sandbox'))).toBeInTheDocument();
    expect(screen.getAllByText(copy.settings.secret.notSet).length).toBeGreaterThan(0);
  });

  it('shows the certificate badge: Saved on production, Not set on sandbox', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    expect(within(screen.getByTestId('setting-cert')).getByText(copy.settings.secret.saved)).toBeInTheDocument();
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sandboxView), { status: 200 })));
    await renderAndWait();
    expect(within(screen.getByTestId('setting-cert')).getByText(copy.settings.secret.notSet)).toBeInTheDocument();
  });

  it('shows "not yet accepted" when the consumer key is saved but not yet verified', async () => {
    const unverified = { ...view, environments: { ...view.environments, production: { ...view.environments.production, credsVerifiedAt: null } } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(unverified), { status: 200 })));
    await renderAndWait();

    expect(screen.getByText(copy.settings.secret.notYetAccepted, { exact: false })).toBeInTheDocument();
  });

  it('replacing creds while sandbox is the mode posts to environments/sandbox/daraja', async () => {
    const fetchMock = mockFetch((url, method) => {
      if (url === '/api/settings/environments/sandbox/daraja' && method === 'POST') return new Response(JSON.stringify({ ok: true, message: 'Safaricom accepted the key and secret.' }), { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    }, sandboxView);
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    const darajaSection = screen.getByTestId('setting-daraja');
    fireEvent.click(within(darajaSection).getByRole('button', { name: copy.settings.replace }));
    fireEvent.change(within(darajaSection).getByLabelText(copy.setup.daraja.key), { target: { value: 'key123' } });
    fireEvent.change(within(darajaSection).getByLabelText(copy.setup.daraja.secret), { target: { value: 'secret123' } });
    fireEvent.click(within(darajaSection).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/environments/sandbox/daraja', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/settings/environments/sandbox/daraja' && (i as RequestInit | undefined)?.method === 'POST');
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({ consumerKey: 'key123', consumerSecret: 'secret123', password: 'studio-pw' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Safaricom accepted the key and secret.'));
  });

  it('shows the shortcode verified-name toast on save', async () => {
    const fetchMock = mockFetch((url, method) => {
      if (url === '/api/settings/environments/production/shortcode' && method === 'PUT') return new Response(JSON.stringify({ verifiedName: 'KEPAS TECHNOLOGIES', verifyError: null }), { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    const shortcodeSection = screen.getByTestId('setting-shortcode');
    fireEvent.click(within(shortcodeSection).getByRole('button', { name: copy.settings.change }));
    fireEvent.change(within(shortcodeSection).getByLabelText(copy.settings.shortcode.label), { target: { value: '4052037' } });
    fireEvent.click(within(shortcodeSection).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(copy.settings.shortcode.knownAs('KEPAS TECHNOLOGIES')));
  });

  it('every visible label comes from copy (spot check a few)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();
    for (const text of [copy.settings.title, copy.settings.appearance.title, copy.settings.daraja, copy.settings.passkey, copy.settings.operatorsTitle, copy.settings.categories.title]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
  });

  it('an operator.updated event refreshes the view, keeping a typed but unsaved shortcode edit', async () => {
    const updatedView = { ...view, environments: { ...view.environments, production: { ...view.environments.production, operators: [{ ...view.environments.production.operators[0], status: 'failed' as const }] } } };
    let settingsGets = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') {
        settingsGets += 1;
        return new Response(JSON.stringify(settingsGets === 1 ? view : updatedView), { status: 200 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    fireEvent.click(within(screen.getByTestId('setting-shortcode')).getByRole('button', { name: copy.settings.change }));
    fireEvent.change(screen.getByLabelText(copy.settings.shortcode.label), { target: { value: '1234567' } });

    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('operator.updated', { type: 'operator.updated', payload: {}, at: new Date().toISOString() });

    await waitFor(() => expect(screen.getByText(copy.settings.operatorStatus.failed)).toBeInTheDocument());
    expect(screen.getByLabelText(copy.settings.shortcode.label)).toHaveValue('1234567');
  });

  it('keeps the confirm dialog open and shows the server message on a 403 step-up failure', async () => {
    const fetchMock = mockFetch((url, method) => {
      if (url === '/api/settings/environments/production/passkey' && method === 'POST') {
        return new Response(JSON.stringify({ error: { code: 'step_up_required', message: 'That password is wrong.' } }), { status: 403 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    const passkeySection = screen.getByTestId('setting-passkey');
    fireEvent.click(within(passkeySection).getByRole('button', { name: copy.settings.replace }));
    fireEvent.change(within(passkeySection).getByLabelText(copy.settings.newPasskey), { target: { value: 'a-new-passkey' } });
    fireEvent.click(within(passkeySection).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'wrong-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(screen.getByText('That password is wrong.')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(copy.confirm.yourPassword)).toHaveValue('wrong-pw');
  });

});
