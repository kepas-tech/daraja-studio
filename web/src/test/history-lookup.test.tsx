import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { History } from '../pages/History';
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

const answered = { id: 'q1', type: 'status_query', subtype: 'lookup', status: 'completed', amountCents: 25000, currency: 'KES', recipient: { kind: 'phone', value: 'RI6BZTPXNM', name: '254700123456 - Jane Doe' }, remarks: null, receipt: 'RI6BZTPXNM', createdAt: '2026-09-06T11:00:00Z', sentAt: '2026-09-06T11:00:01Z', resultAt: '2026-09-06T11:00:05Z', resultSource: 'callback', safaricomSaid: 'The service request is processed successfully.', meaning: 'Safaricom reports this transaction as Completed.', whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null };

describe('History › Ask Safaricom about a receipt', () => {
  it('does not offer Safaricom for a receipt that is already in the list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ ...answered, type: 'b2c', receipt: 'RI6BZTPXNM' }], nextCursor: null }), { status: 200 })));
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'RI6BZTPXNM' } });
    await screen.findAllByText('RI6BZTPXNM');
    expect(screen.queryByRole('button', { name: copy.lookup.ask })).not.toBeInTheDocument();
  });

  it('validates, asks, and renders the live answer', async () => {
    let body: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'POST /api/lookup') { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ requestId: 'q1' }), { status: 202 }); }
      if (key === 'GET /api/requests/q1') return new Response(JSON.stringify(answered), { status: 200 });
      if (key.startsWith('GET /api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
    await screen.findAllByText(copy.lookup.asking);
    expect(body).toEqual({ receipt: 'RI6BZTPXNM' });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('request.updated', { type: 'request.updated', payload: { id: 'q1', status: 'completed' }, at: new Date().toISOString() });
    await screen.findByText('Safaricom reports this transaction as Completed.');
    await waitFor(() => expect(screen.getByText('KES 250')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('254700123456 - Jane Doe')).toBeInTheDocument());
  });

  it('W2: re-fetches on SSE reconnect (open) without waiting for a missed event', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'POST /api/lookup') return new Response(JSON.stringify({ requestId: 'q1' }), { status: 202 });
      if (key === 'GET /api/requests/q1') return new Response(JSON.stringify(answered), { status: 200 });
      if (key.startsWith('GET /api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
    await screen.findAllByText(copy.lookup.asking);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    // No 'request.updated' event is ever emitted — only the connection's own open fires.
    es.onopen?.();
    await screen.findByText('Safaricom reports this transaction as Completed.');
  });

  it('W2: falls back to a 15s poll while a lookup is pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(input)}`;
        if (key === 'POST /api/lookup') return new Response(JSON.stringify({ requestId: 'q1' }), { status: 202 });
        if (key === 'GET /api/requests/q1') { calls++; return new Response(JSON.stringify(answered), { status: 200 }); }
        if (key.startsWith('GET /api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<MemoryRouter><History /></MemoryRouter>);
      fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
      fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
      await screen.findAllByText(copy.lookup.asking);
      await vi.advanceTimersByTimeAsync(15_000);
      await screen.findByText('Safaricom reports this transaction as Completed.');
      expect(calls).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('shows the three-line card when Safaricom rejects the lookup', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'POST /api/lookup') return new Response(JSON.stringify({ error: { code: 'safaricom_rejected', message: 'Safaricom rejected the request.', details: { safaricomSaid: 'The transaction is not permitted to your account.', meaning: 'Wrong receipt or account.' } } }), { status: 502 });
      if (key.startsWith('GET /api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy.error.safaricomSaid);
    expect(alert).toHaveTextContent('The transaction is not permitted to your account.');
    expect(alert).toHaveTextContent(copy.error.meaning);
    expect(alert).toHaveTextContent('Wrong receipt or account.');
  });

  it('shows the in-flight message on a 409 lookup_in_flight', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'POST /api/lookup') return new Response(JSON.stringify({ error: { code: 'lookup_in_flight', message: 'x' } }), { status: 409 });
      if (key.startsWith('GET /api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
    await screen.findByText(copy.lookup.inFlight);
  });

  it('shows a plain error card when a failed lookup has no what-to-do', async () => {
    const failed = { id: 'q1', type: 'status_query', subtype: 'lookup', status: 'failed', amountCents: 25000, currency: 'KES', recipient: { kind: 'phone', value: 'RI6BZTPXNM', name: null }, remarks: null, receipt: null, createdAt: '2026-09-06T11:00:00Z', sentAt: null, resultAt: '2026-09-06T11:00:05Z', resultSource: 'callback', safaricomSaid: 'The transaction is not permitted to your account.', meaning: 'Wrong receipt or account.', whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'POST /api/lookup') return new Response(JSON.stringify({ requestId: 'q1' }), { status: 202 });
      if (key === 'GET /api/requests/q1') return new Response(JSON.stringify(failed), { status: 200 });
      if (key.startsWith('GET /api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
    await screen.findAllByText(copy.lookup.asking);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('request.updated', { type: 'request.updated', payload: { id: 'q1', status: 'failed' }, at: new Date().toISOString() });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Wrong receipt or account.');
  });

  it('renders the message for an unmapped ApiError code', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/requests?') ? new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }) : new Response(JSON.stringify({ error: { code: 'no_operator', message: 'Add an API operator in Settings first.' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
    await screen.findByText('Add an API operator in Settings first.');
  });

  it('falls back to the generic message for a non-API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { if (String(input).startsWith('/api/requests?')) return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }); throw new TypeError('Failed to fetch'); }));
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.lookup.ask }));
    await screen.findByText(copy.error.generic);
  });
});
