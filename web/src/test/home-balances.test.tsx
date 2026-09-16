import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Home } from '../pages/Home';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent); }
}
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());
const fresh = { workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 2500, queriedAt: new Date().toISOString() };
const slot = { shortcode: null, consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: 'x', passkey: { saved: false, last4: null }, cert: { saved: false, last4: null }, operators: [], ready: { creds: true, operator: true }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } };
const settings = { mode: 'sandbox', environments: { sandbox: slot, production: slot }, org: { name: 'APIONE', nominatedNumber: '', notificationPhone: '' }, publicVerifiedAt: 'x', stkEnabled: true, publicUrl: 'x', httpsSeen: true, allowlist: [], setupCompletedAt: 'x', sendCategories: [], approvalThresholdCents: 0 };

function mount(latestRef: { value: unknown }, onRefresh: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    if (key === 'GET /api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: null }), { status: 200 });
    if (key === 'GET /api/auth/me') return new Response(JSON.stringify({ person: { id: '1', username: 'owner', display_name: 'Owner', is_owner: true, must_change_password: false }, csrf: 'c', permissions: [], org: { id: 'o', name: 'APIONE', status: 'verified', environment: 'sandbox', isHost: true, suspendReason: null } }), { status: 200 });
    if (key === 'GET /api/settings') return new Response(JSON.stringify(settings), { status: 200 });
    if (key === 'GET /api/balances/latest') return new Response(JSON.stringify(latestRef.value), { status: 200 });
    if (key.startsWith('GET /api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    if (key === 'POST /api/balances/refresh') return onRefresh();
    if (key.startsWith('GET /api/requests/')) return new Response(JSON.stringify({ status: 'sent' }), { status: 200 });
    throw new Error(`unexpected fetch ${key}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><SessionProvider><ToastHost /><Home /></SessionProvider></MemoryRouter>);
  return fetchMock;
}

describe('Home › balances (the old Balances page)', () => {
  it('shows the empty state, refreshes, and updates on balance.updated with charges paid', async () => {
    const latest = { value: null as unknown };
    mount(latest, () => { latest.value = fresh; return new Response(JSON.stringify({ requestId: 'b1' }), { status: 202 }); });
    await screen.findByText(copy.balances.never);
    fireEvent.click(screen.getByRole('button', { name: copy.balances.refresh }));
    await screen.findByText(copy.balances.refreshing, { selector: 'button' });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    FakeEventSource.instances[FakeEventSource.instances.length - 1]!.emit('balance.updated', { type: 'balance.updated', payload: {}, at: new Date().toISOString() });
    await screen.findByText('KES 34,392');
    expect(screen.getByText('KES 14')).toBeInTheDocument();
    expect(screen.getByText(`${copy.balances.charges}: KES 25`, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.balances.refresh })).toBeInTheDocument();
  });

  it('says so when Safaricom never answers', async () => {
    const latest = { value: null as unknown };
    mount(latest, () => new Response(JSON.stringify({ requestId: 'b1' }), { status: 202 }));
    await screen.findByText(copy.balances.never);
    fireEvent.click(screen.getByRole('button', { name: copy.balances.refresh }));
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    // The pending id lands once the refresh POST resolves; keep emitting until the page has it.
    await waitFor(() => {
      FakeEventSource.instances[FakeEventSource.instances.length - 1]!.emit('request.updated', { type: 'request.updated', payload: { id: 'b1', status: 'unknown' }, at: new Date().toISOString() });
      expect(screen.getAllByText(copy.balances.noAnswer).length).toBeGreaterThan(0);
    });
  });
});
