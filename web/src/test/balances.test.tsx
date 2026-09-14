import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Balances } from '../pages/Balances';
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
const fresh = { workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: new Date().toISOString() };

describe('Balances', () => {
  it('shows the empty state, refreshes, and updates on balance.updated', async () => {
    let latest: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/balances/latest') return new Response(JSON.stringify(latest), { status: 200 });
      if (key === 'POST /api/balances/refresh') { latest = fresh; return new Response(JSON.stringify({ requestId: 'b1' }), { status: 202 }); }
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Balances /></MemoryRouter>);
    await screen.findByText(copy.balances.never);
    fireEvent.click(screen.getByRole('button', { name: copy.balances.refresh }));
    await screen.findByText(copy.balances.refreshing);
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('balance.updated', { type: 'balance.updated', payload: { at: new Date().toISOString() }, at: new Date().toISOString() });
    await screen.findByText('KES 34,392');
    expect(screen.getByText('KES 14')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.balances.refresh })).toBeInTheDocument();
  });

  it('W2: re-fetches on SSE reconnect (open) without waiting for a missed event', async () => {
    let latest: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/balances/latest') return new Response(JSON.stringify(latest), { status: 200 });
      if (key === 'POST /api/balances/refresh') return new Response(JSON.stringify({ requestId: 'b1' }), { status: 202 });
      if (key === 'GET /api/requests/b1') { latest = fresh; return new Response(JSON.stringify({ status: 'completed' }), { status: 200 }); }
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Balances /></MemoryRouter>);
    await screen.findByText(copy.balances.never);
    fireEvent.click(screen.getByRole('button', { name: copy.balances.refresh }));
    await screen.findByText(copy.balances.refreshing);
    // `pending` is only set once the POST resolves, one tick after the busy text renders — the
    // EventSource is recreated (new onOpen closure) when that happens, so wait for that before
    // grabbing the "current" instance.
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(1));
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    // No 'balance.updated'/'request.updated' event is ever emitted — only open fires.
    es.onopen?.();
    await screen.findByText('KES 34,392');
    expect(screen.getByRole('button', { name: copy.balances.refresh })).toBeInTheDocument();
  });

  it('W2: falls back to a 15s poll while a refresh is pending, clearing busy on an unknown result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(input)}`;
        if (key === 'GET /api/balances/latest') return new Response(JSON.stringify(null), { status: 200 });
        if (key === 'POST /api/balances/refresh') return new Response(JSON.stringify({ requestId: 'b1' }), { status: 202 });
        if (key === 'GET /api/requests/b1') { calls++; return new Response(JSON.stringify({ status: 'unknown' }), { status: 200 }); }
        throw new Error(`unexpected fetch ${key}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<MemoryRouter><Balances /></MemoryRouter>);
      await screen.findByText(copy.balances.never);
      fireEvent.click(screen.getByRole('button', { name: copy.balances.refresh }));
      await screen.findByText(copy.balances.refreshing);
      await vi.advanceTimersByTimeAsync(15_000);
      await screen.findByText(copy.balances.noAnswer);
      expect(calls).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('flags a stale snapshot and shows the in-flight message on 409', async () => {
    const stale = { ...fresh, queriedAt: new Date(Date.now() - 2 * 86400_000).toISOString() };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/balances/latest') return new Response(JSON.stringify(stale), { status: 200 });
      if (key === 'POST /api/balances/refresh') return new Response(JSON.stringify({ error: { code: 'refresh_in_flight', message: 'x' } }), { status: 409 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Balances /></MemoryRouter>);
    await screen.findByText(copy.balances.stale);
    fireEvent.click(screen.getByRole('button', { name: copy.balances.refresh }));
    await screen.findByText(copy.balances.inFlight);
  });

  it('shows the three-line card when Safaricom rejects the refresh', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/balances/latest') return new Response(JSON.stringify(null), { status: 200 });
      if (key === 'POST /api/balances/refresh') return new Response(JSON.stringify({ error: { code: 'safaricom_rejected', message: 'Safaricom rejected the request.', details: { safaricomSaid: 'The initiator information is invalid.', meaning: 'Bad credential.' } } }), { status: 502 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Balances /></MemoryRouter>);
    await screen.findByText(copy.balances.never);
    fireEvent.click(screen.getByRole('button', { name: copy.balances.refresh }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy.error.safaricomSaid);
    expect(alert).toHaveTextContent('The initiator information is invalid.');
    expect(alert).toHaveTextContent(copy.error.meaning);
    expect(alert).toHaveTextContent('Bad credential.');
  });
});
