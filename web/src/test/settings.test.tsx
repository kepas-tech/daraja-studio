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
};

function mockFetch(handle: (url: string, method: string, init?: RequestInit) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify(view), { status: 200 });
    return handle(url, method, init);
  });
}

function renderSettings() {
  return render(<MemoryRouter><ToastHost /><Settings /></MemoryRouter>);
}

async function renderAndWait() {
  renderSettings();
  await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
}

describe('Settings', () => {
  it('renders two tabs; the active mode (production) is selected and marked "In use"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.replace(copy.settings.mode.inUse, '').trim())).toEqual([copy.settings.tabs.sandbox, copy.settings.tabs.production]);
    const productionTab = screen.getByRole('tab', { name: new RegExp(copy.settings.tabs.production) });
    expect(productionTab).toHaveAttribute('aria-selected', 'true');
    expect(within(productionTab).getByText(copy.settings.mode.inUse)).toBeInTheDocument();
    const sandboxTab = screen.getByRole('tab', { name: copy.settings.tabs.sandbox });
    expect(sandboxTab).toHaveAttribute('aria-selected', 'false');
  });

  it('production tab shows the saved creds and verified-at from the fixture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(copy.settings.secret.savedEndsIn('4f2a'), { exact: false })).toBeInTheDocument();
    expect(within(panel).getByText(copy.settings.secret.verifiedAt('').trim(), { exact: false })).toBeInTheDocument();
  });

  it('sandbox tab shows "Not set" once selected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    fireEvent.click(screen.getByRole('tab', { name: copy.settings.tabs.sandbox }));
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getAllByText(copy.settings.secret.notSet).length).toBeGreaterThan(0);
  });

  it('shows the certificate badge: Saved on production, Not set on sandbox', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    const productionPanel = screen.getByRole('tabpanel');
    expect(within(productionPanel).getByText(`${copy.settings.cert.label}: ${copy.settings.secret.saved}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: copy.settings.tabs.sandbox }));
    const sandboxPanel = await screen.findByRole('tabpanel');
    expect(within(sandboxPanel).getByText(`${copy.settings.cert.label}: ${copy.settings.secret.notSet}`)).toBeInTheDocument();
  });

  it('shows "not yet accepted" when the consumer key is saved but not yet verified', async () => {
    const unverified = { ...view, environments: { ...view.environments, production: { ...view.environments.production, credsVerifiedAt: null } } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(unverified), { status: 200 })));
    await renderAndWait();

    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(copy.settings.secret.notYetAccepted, { exact: false })).toBeInTheDocument();
  });

  it('arrow keys move focus and selection between tabs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByRole('tab', { name: copy.settings.tabs.sandbox })).toHaveAttribute('aria-selected', 'true'));
  });

  it('switching to production requires the shortcode: a mismatch toasts an error and keeps the field, a match toasts success', async () => {
    const sandboxActive = { ...view, mode: 'sandbox' };
    let attempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify(sandboxActive), { status: 200 });
      if (url === '/api/settings/mode' && method === 'PUT') {
        attempt += 1;
        if (attempt === 1) return new Response(JSON.stringify({ error: { code: 'confirm_shortcode', message: 'Type your shortcode exactly to switch to production.' } }), { status: 400 });
        return new Response(JSON.stringify({ mode: 'production', ready: { creds: true, operator: true } }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    fireEvent.click(screen.getByLabelText(copy.settings.mode.production, { exact: false }));
    fireEvent.change(screen.getByLabelText(copy.settings.mode.confirmShortcode), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.confirm.switchMode('production') }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Type your shortcode exactly to switch to production.'));
    // The dialog closed (this was not a wrong-password failure) but the inline field is still there.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText(copy.settings.mode.confirmShortcode)).toHaveValue('wrong');

    fireEvent.change(screen.getByLabelText(copy.settings.mode.confirmShortcode), { target: { value: '4052037' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.confirm.switchMode('production') }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(copy.settings.mode.switched('production')));
  });

  it('replacing creds from the sandbox tab posts to environments/sandbox/daraja', async () => {
    const fetchMock = mockFetch((url, method) => {
      if (url === '/api/settings/environments/sandbox/daraja' && method === 'POST') return new Response(JSON.stringify({ ok: true, message: 'Safaricom accepted the key and secret.' }), { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    fireEvent.click(screen.getByRole('tab', { name: copy.settings.tabs.sandbox }));
    await screen.findByRole('tabpanel');
    const darajaSection = screen.getByText(copy.settings.daraja).closest('section')!;
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

  it('Test again on an other-env operator (viewing production while sandbox is active) is disabled with the switch hint', async () => {
    const sandboxActive = { ...view, mode: 'sandbox' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(sandboxActive), { status: 200 })));
    await renderAndWait();

    fireEvent.click(screen.getByRole('tab', { name: copy.settings.tabs.production }));
    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('KEPAS', { selector: 'span.font-medium' });
    expect(within(panel).getByRole('button', { name: copy.settings.probe })).toBeDisabled();
    expect(within(panel).getByText(copy.settings.operators.switchToTest('production'))).toBeInTheDocument();
  });

  it('shows the shortcode verified-name toast on save', async () => {
    const fetchMock = mockFetch((url, method) => {
      if (url === '/api/settings/environments/production/shortcode' && method === 'PUT') return new Response(JSON.stringify({ verifiedName: 'KEPAS TECHNOLOGIES', verifyError: null }), { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    const shortcodeSection = screen.getByText(copy.settings.shortcode.label, { selector: 'h2' }).closest('section')!;
    fireEvent.change(within(shortcodeSection).getByLabelText(copy.settings.shortcode.label), { target: { value: '4052037' } });
    fireEvent.click(within(shortcodeSection).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(copy.settings.shortcode.knownAs('KEPAS TECHNOLOGIES')));
  });

  it('every visible label comes from copy (spot check a few)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();
    for (const text of [copy.settings.title, copy.settings.organisation.title, copy.settings.mode.title, copy.settings.org, copy.settings.daraja, copy.settings.passkey, copy.settings.operatorsTitle, copy.settings.allowlist]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
  });

  it('an operator.updated event refreshes the view, keeping a typed but unsaved public-url edit', async () => {
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

    fireEvent.change(screen.getByLabelText(copy.setup.publicUrl.field), { target: { value: 'https://not-yet-saved.example' } });

    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('operator.updated', { type: 'operator.updated', payload: {}, at: new Date().toISOString() });

    await waitFor(() => expect(screen.getByText(copy.settings.operatorStatus.failed)).toBeInTheDocument());
    expect(screen.getByLabelText(copy.setup.publicUrl.field)).toHaveValue('https://not-yet-saved.example');
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

    const passkeySection = screen.getByText(copy.settings.passkey, { selector: 'h2' }).closest('section')!;
    fireEvent.change(within(passkeySection).getByLabelText(copy.settings.newPasskey), { target: { value: 'a-new-passkey' } });
    fireEvent.click(within(passkeySection).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'wrong-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(screen.getByText('That password is wrong.')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(copy.confirm.yourPassword)).toHaveValue('wrong-pw');
  });

  it('reveals the install secret, then hides it again', async () => {
    const fetchMock = mockFetch((url, method) => {
      if (url === '/api/settings/install-secret/reveal' && method === 'POST') return new Response(JSON.stringify({ secret: 'top-secret-value' }), { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    fireEvent.click(screen.getByRole('button', { name: copy.settings.revealSecret }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(screen.getByText('top-secret-value')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: copy.settings.hideSecret }));
    expect(screen.queryByText('top-secret-value')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.settings.revealSecret })).toBeInTheDocument();
  });

  it('shows the not-ready line joined without repeating "add" for the active mode', async () => {
    const notReady = { ...view, environments: { ...view.environments, production: { ...view.environments.production, ready: { creds: false, operator: false } } } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(notReady), { status: 200 })));
    await renderAndWait();

    expect(screen.getByText('Production is not ready: add the Daraja key and secret, and an API operator, in the Production tab.')).toBeInTheDocument();
  });
});
