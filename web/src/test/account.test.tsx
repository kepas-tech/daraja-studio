import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Account } from '../pages/Account';
import type { ReactNode } from 'react';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

// jsdom has no EventSource; the page subscribes to operator updates. Captures listeners so a test
// can emit one.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, EventListener[]> = {};
  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent); }
}

afterEach(() => cleanup());

const slot = (over: object = {}) => ({
  shortcode: null,
  consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null,
  passkey: { saved: false, last4: null }, passkeyProven: false, cert: { saved: false, last4: null },
  operators: [], ready: { creds: false, operator: false },
  b2cApi: { setting: 'auto', detected: null, detectedAt: null },
  ...over,
});
const productionSlot = slot({
  shortcode: '700111', consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: '2026-09-07T07:00:00Z',
  cert: { saved: true, last4: null },
  operators: [{ id: 'a', name: 'APIONE', environment: 'production', status: 'verified', priority: 1, rotatedAt: '2026-09-02T00:00:00Z', lastProbeAt: null, lastError: null, expiresAt: '2026-12-01T00:00:00Z' }],
  ready: { creds: true, operator: true },
});

const view = {
  mode: 'production',
  environments: { sandbox: slot({ shortcode: '174379' }), production: productionSlot },
  org: { name: 'ACME TRADERS', nominatedNumber: '254700000000', notificationPhone: '254700000000' },
  stkEnabled: false, publicUrl: 'https://darajastudio.com', publicVerifiedAt: '2026-09-08T04:00:00Z', httpsSeen: true,
  allowlist: ['196.201.214.200'], setupCompletedAt: '2026-09-01T09:00:00Z',
  sendCategories: [], approvalThresholdCents: 0, uses: { payOut: true, collect: true, stk: false },
};
const sandboxView = { ...view, mode: 'sandbox' };

function mount(handlers: (url: string, method: string, init?: RequestInit) => Response, data: unknown = view, page: ReactNode = <Account />) {
  let settingsGets = 0;
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
    if (url === '/api/settings' && method === 'GET') { settingsGets += 1; const d = typeof data === 'function' ? (data as (n: number) => unknown)(settingsGets) : data; return new Response(JSON.stringify(d), { status: 200 }); }
    return handlers(url, method, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
  render(<MemoryRouter><SessionProvider><ToastHost />{page}</SessionProvider></MemoryRouter>);
  return fetchMock;
}
const none = () => { throw new Error('no other call expected'); };

describe('Organisation › business and people', () => {
  it('names the organisation, when it signed up and when Safaricom verified it', async () => {
    mount(none);
    await screen.findByTestId('setting-org');
    expect(screen.getAllByText('ACME TRADERS').length).toBeGreaterThan(0);
    expect(screen.getByText(copy.org.signedUp, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(copy.org.verifiedOn, { exact: false })).toBeInTheDocument();
  });

  it('links to the People page', async () => {
    mount(none);
    expect(await screen.findByRole('link', { name: copy.settings.organisation.peopleLink })).toHaveAttribute('href', '/people');
  });
});

describe('Organisation › environments', () => {
  it('shows the mode in use first and open, the other behind Show, each with its status line', async () => {
    mount(none);
    await screen.findByTestId('env-status-production');
    expect(screen.getByTestId('env-status-production')).toHaveTextContent(copy.account.env.ready);
    expect(screen.getByTestId('env-status-production')).toHaveTextContent(copy.account.env.inUse);
    expect(screen.queryByTestId('env-status-sandbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.account.env.show }));
    expect(screen.getByTestId('env-status-sandbox')).toHaveTextContent(copy.account.env.notReady);
    expect(screen.getByTestId('env-status-sandbox')).toHaveTextContent(copy.account.env.needCreds);
  });

  it('shows the active environment with its saved creds, verified-at and certificate', async () => {
    mount(none);
    await screen.findByTestId('setting-daraja');
    expect(screen.getByText(copy.settings.secret.savedEndsIn('4f2a'), { exact: false })).toBeInTheDocument();
    expect(screen.getByText(copy.settings.secret.verifiedAt('').trim(), { exact: false })).toBeInTheDocument();
    expect(within(screen.getByTestId('setting-cert')).getByText(copy.settings.secret.saved)).toBeInTheDocument();
  });

  it('shows "not yet accepted" when the consumer key is saved but not yet verified', async () => {
    mount(none, { ...view, environments: { ...view.environments, production: { ...productionSlot, credsVerifiedAt: null } } });
    await screen.findByTestId('setting-daraja');
    expect(screen.getByText(copy.settings.secret.notYetAccepted, { exact: false })).toBeInTheDocument();
  });

  it('lists both shortcodes and saves one after the password', async () => {
    let put: unknown = null;
    mount((url, method, init) => {
      if (url === '/api/settings/environments/sandbox/shortcode' && method === 'PUT') { put = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ verifiedName: null, verifyError: null }), { status: 200 }); }
      throw new Error(`unexpected ${method} ${url}`);
    }, sandboxView);
    const row = await screen.findByTestId('shortcode-sandbox');
    expect(row).toHaveTextContent('174379');
    fireEvent.click(screen.getByRole('button', { name: copy.account.env.show }));
    expect(screen.getByTestId('shortcode-production')).toHaveTextContent('700111');
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.change }));
    fireEvent.change(within(row).getByLabelText(copy.settings.shortcode.label), { target: { value: '600000' } });
    fireEvent.click(within(row).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'owner-password' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(put).toEqual({ shortcode: '600000', password: 'owner-password' }));
  });

  it('replacing creds while sandbox is the mode posts to environments/sandbox/daraja', async () => {
    const fetchMock = mount((url, method) => {
      if (url === '/api/settings/environments/sandbox/daraja' && method === 'POST') return new Response(JSON.stringify({ ok: true, message: 'Safaricom accepted the key and secret.' }), { status: 200 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    }, sandboxView);
    const darajaSection = await screen.findByTestId('setting-daraja');
    fireEvent.click(within(darajaSection).getByRole('button', { name: copy.settings.replace }));
    fireEvent.change(within(darajaSection).getByLabelText(copy.setup.daraja.key), { target: { value: 'key123' } });
    fireEvent.click(within(darajaSection).getByRole('button', { name: copy.questionnaire.next }));
    fireEvent.change(within(darajaSection).getByLabelText(copy.setup.daraja.secret), { target: { value: 'secret123' } });
    fireEvent.click(within(darajaSection).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/environments/sandbox/daraja', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/settings/environments/sandbox/daraja' && (i as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ consumerKey: 'key123', consumerSecret: 'secret123', password: 'studio-pw' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Safaricom accepted the key and secret.'));
  });

  it('an operator.updated event refreshes the view, keeping a typed but unsaved consumer key', async () => {
    const updatedView = { ...view, environments: { ...view.environments, production: { ...productionSlot, operators: [{ ...(productionSlot.operators[0] as object), status: 'failed' }] } } };
    mount(none, (n: number) => (n === 1 ? view : updatedView));
    await screen.findByTestId('setting-daraja');
    fireEvent.click(within(screen.getByTestId('setting-daraja')).getByRole('button', { name: copy.settings.replace }));
    fireEvent.change(screen.getByLabelText(copy.setup.daraja.key), { target: { value: 'typed-key' } });
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('operator.updated', { type: 'operator.updated', payload: {}, at: new Date().toISOString() });
    await waitFor(() => expect(screen.getByText(copy.settings.operatorStatus.failed)).toBeInTheDocument());
    expect(screen.getByLabelText(copy.setup.daraja.key)).toHaveValue('typed-key');
  });

  it('keeps the confirm dialog open and shows the server message on a 403 step-up failure', async () => {
    mount((url, method) => {
      if (url === '/api/settings/environments/production/passkey' && method === 'POST') return new Response(JSON.stringify({ error: { code: 'step_up_required', message: 'That password is wrong.' } }), { status: 403 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    const passkeySection = await screen.findByTestId('setting-passkey');
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

describe('Organisation › mode, go live, delete', () => {
  it('offers Go live only while in sandbox with production not ready', async () => {
    mount(none, { ...sandboxView, environments: { ...view.environments, production: slot() } });
    await screen.findByTestId('go-live-card');
    expect(screen.getByRole('link', { name: copy.account.goLive.button })).toHaveAttribute('href', '/go-live');
    cleanup();
    mount(none);
    await screen.findByTestId('setting-org');
    expect(screen.queryByTestId('go-live-card')).toBeNull();
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
    }, sandboxView);
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
