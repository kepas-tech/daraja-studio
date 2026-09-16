import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Home } from '../pages/Home';
import { copy } from '../copy/en';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  /** A real EventSource opens itself as soon as the browser connects it; a test can ask for that. */
  static autoOpen = false;
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  closed = false;
  constructor() {
    FakeEventSource.instances.push(this);
    // A microtask, so the assignment of onopen right after construction has happened.
    if (FakeEventSource.autoOpen) queueMicrotask(() => { if (!this.closed) this.onopen?.(); });
  }
  addEventListener(t: string, cb: EventListener) { (this.listeners[t] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent); }
}
vi.stubGlobal('EventSource', FakeEventSource);
const lastES = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
beforeEach(() => { FakeEventSource.instances.length = 0; FakeEventSource.autoOpen = false; });
afterEach(() => cleanup());

describe('Home', () => {
  it('shows the latest balance and the recent requests above the alerts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: null }), { status: 200 });
      if (url === '/api/auth/me') return new Response(JSON.stringify({ person: { id: '1', username: 'owner', display_name: 'Host Owner', is_owner: true, must_change_password: false }, csrf: 'c', permissions: [] }), { status: 200 });
      if (url === '/api/settings') {
        const slot = { shortcode: null, consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: 'x', passkey: { saved: false, last4: null }, cert: { saved: false, last4: null }, operators: [{ id: 'a', name: 'KEPAS', environment: 'sandbox', status: 'verified', priority: 1, rotatedAt: 'x', lastProbeAt: null, lastError: null, expiresAt: 'x' }], ready: { creds: true, operator: true }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } };
        return new Response(JSON.stringify({ mode: 'sandbox', environments: { sandbox: slot, production: { ...slot, operators: [], ready: { creds: false, operator: false } } }, org: { name: '', nominatedNumber: '', notificationPhone: '' }, publicVerifiedAt: 'x', stkEnabled: true, publicUrl: 'x', httpsSeen: true, allowlist: [], setupCompletedAt: 'x' }), { status: 200 });
      }
      if (url === '/api/balances/latest') return new Response(JSON.stringify({ workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: new Date().toISOString() }), { status: 200 });
      if (url.startsWith('/api/requests?')) return new Response(JSON.stringify({ items: [{ id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'completed', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: null, receipt: 'RI1', createdAt: '2026-09-06T11:00:00Z', sentAt: null, resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null }], nextCursor: null }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SessionProvider><Home /></SessionProvider></MemoryRouter>);
    await screen.findByText('KES 34,392');
    expect(screen.getByText(copy.home.recent)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /0700 123 456/ })).toHaveAttribute('href', '/requests/r1');
    expect(screen.getByText(copy.home.connected)).toBeInTheDocument();
  });
});

const hostedSettings = {
  mode: 'sandbox',
  environments: {
    sandbox: { shortcode: null, consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: 'x', passkey: { saved: false, last4: null }, cert: { saved: false, last4: null }, operators: [{ id: 'a', name: 'KEPAS', environment: 'sandbox', status: 'verified', priority: 1, rotatedAt: 'x', lastProbeAt: null, lastError: null, expiresAt: 'x' }], ready: { creds: true, operator: true }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } },
    production: { shortcode: null, consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null, passkey: { saved: false, last4: null }, cert: { saved: false, last4: null }, operators: [], ready: { creds: false, operator: false }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } },
  },
  org: { name: 'One Ltd', nominatedNumber: '', notificationPhone: '' },
  stkEnabled: true, publicUrl: 'https://x', publicVerifiedAt: 'x', httpsSeen: true, allowlist: [], setupCompletedAt: 'x',
};

const me = () => ({
  person: { id: '1', username: 'owner', display_name: 'Owner', is_owner: true, must_change_password: false },
  csrf: 'c', permissions: [],
  org: { id: 'o1', name: 'One Ltd', status: 'verified', environment: 'sandbox', isHost: true, suspendReason: null },
});

/** A Home with mutable state, so an event can change what the next read returns. */
function mountHome(state: { me: unknown }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: null }), { status: 200 });
    if (url === '/api/auth/me') return new Response(JSON.stringify(state.me), { status: 200 });
    if (url === '/api/settings') return new Response(JSON.stringify(hostedSettings), { status: 200 });
    if (url === '/api/balances/latest') return new Response('null', { status: 200 });
    if (url.startsWith('/api/requests')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    throw new Error('unexpected ' + method + ' ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<MemoryRouter><SessionProvider><Home /></SessionProvider></MemoryRouter>);
  return { fetchMock, unmount: view.unmount };
}

describe('Home header', () => {
  it('shows the name Safaricom holds for the shortcode, the shortcode, the environment and the business\'s own name', async () => {
    const state = { me: { ...me(), org: { ...me().org, environment: 'production', shortcode: '700111', safaricomName: 'KEPAS TECHNOLOGIES' } } };
    const { unmount } = mountHome(state);
    await screen.findByRole('heading', { level: 1, name: 'KEPAS TECHNOLOGIES' });
    expect(screen.getByText(copy.home.shortcodeLine('700111', 'production', 'One Ltd'))).toBeInTheDocument();
    expect(copy.home.shortcodeLine('700111', 'production', 'One Ltd')).toBe('Shortcode 700111 · Real money · Production · One Ltd');
    unmount();
  });
  it('falls back to the business name and says when no shortcode is set', async () => {
    const { unmount } = mountHome({ me: me() });
    await screen.findByRole('heading', { level: 1, name: 'One Ltd' });
    expect(screen.getByText(copy.home.shortcodeLine(null, 'sandbox', null))).toBeInTheDocument();
    unmount();
  });
});

describe('Home stream stability (PB1-F1)', () => {
  it('keeps one automatically-opening stream and stops re-reading the session', async () => {
    FakeEventSource.autoOpen = true;
    const state: { me: unknown } = { me: me() };
    const { fetchMock, unmount } = mountHome(state);
    await screen.findByText(copy.home.connected);

    const meCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/auth/me').length;
    // Every new connection opens itself, as a browser's does. The cap makes an unfixed loop fail
    // here instead of running on.
    await waitFor(() => expect(FakeEventSource.instances.length).toBeLessThan(20), { timeout: 3000 });
    await waitFor(() => expect(meCalls()).toBeGreaterThanOrEqual(2), { timeout: 3000 });

    // Initial loading may legitimately build the stream twice (the session moves from anonymous to
    // ready). After that, an equivalent refresh must create no further connection and read nothing.
    const settled = meCalls();
    const connections = FakeEventSource.instances.length;
    expect(connections).toBeLessThanOrEqual(2);
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(meCalls()).toBe(settled);
      expect(FakeEventSource.instances).toHaveLength(connections);
    }

    // A real reconnect (the same connection opening again) still refreshes the session once.
    lastES().onopen?.();
    await waitFor(() => expect(meCalls()).toBe(settled + 1));
    expect(FakeEventSource.instances).toHaveLength(connections);

    // Leaving the page closes the stream (every connection it ever made).
    unmount();
    expect(FakeEventSource.instances.every((es) => es.closed)).toBe(true);
  });
});
