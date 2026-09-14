import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RequestDetail } from '../pages/RequestDetail';
import { copy } from '../copy/en';

class FakeEventSource { static instances: FakeEventSource[] = []; listeners: Record<string, EventListener[]> = {}; onopen: (() => void) | null = null; constructor() { FakeEventSource.instances.push(this); } addEventListener(t: string, cb: EventListener) { (this.listeners[t] ??= []).push(cb); } close() {} emit(t: string, d: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(d) } as MessageEvent); } }
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

const unknown = { id: 'r9', type: 'b2c', subtype: 'BusinessPayment', status: 'unknown', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: null, receipt: null, createdAt: '2026-09-06T11:00:00Z', sentAt: '2026-09-06T11:00:01Z', resultAt: '2026-09-06T11:15:00Z', resultSource: null, safaricomSaid: null, meaning: 'No answer from Safaricom after 5 checks.', whatToDo: 'Check the Safaricom portal, then Mark as checked.', retriable: false, pollAttempts: 5, checked: null, createdBy: { id: 'p', displayName: 'Owner' } };

function renderAt(id: string) {
  return render(<MemoryRouter initialEntries={[`/requests/${id}`]}><Routes><Route path="/requests/:id" element={<RequestDetail />} /></Routes></MemoryRouter>);
}

describe('RequestDetail', () => {
  it('marks an unknown request as checked with a note and password', async () => {
    let body: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/requests/r9') return new Response(JSON.stringify(unknown), { status: 200 });
      if (key === 'POST /api/requests/r9/checked') { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ ...unknown, checked: { by: { id: 'p', displayName: 'Owner' }, at: '2026-09-06T12:00:00Z', note: 'Paid, seen in portal' } }), { status: 200 }); }
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAt('r9');
    await screen.findByText(copy.request.status.unknown);
    fireEvent.change(screen.getByLabelText(copy.request.markCheckedNote), { target: { value: 'Paid, seen in portal' } });
    fireEvent.click(screen.getByRole('button', { name: copy.request.markChecked }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.request.checkedBy('Owner', 'Paid, seen in portal'));
    expect(body).toEqual({ note: 'Paid, seen in portal', password: 'studio-pw' });
  });

  it('runs a manual check and follows the live update', async () => {
    const sent = { ...unknown, status: 'sent', meaning: null, whatToDo: null, pollAttempts: 1 };
    let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/requests/r9') { calls++; return new Response(JSON.stringify(calls === 1 ? sent : { ...sent, status: 'completed', receipt: 'RI9' }), { status: 200 }); }
      if (key === 'POST /api/requests/r9/check') return new Response(JSON.stringify({ requestId: 'q1' }), { status: 202 });
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAt('r9');
    await screen.findByText(copy.request.status.sent);
    fireEvent.click(screen.getByRole('button', { name: copy.request.checkNow }));
    await screen.findByText(copy.request.checkSent);
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('request.updated', { type: 'request.updated', payload: { id: 'r9', status: 'completed' }, at: new Date().toISOString() });
    await screen.findByText('RI9');
    expect(screen.getByRole('link', { name: copy.request.sendAgain })).toHaveAttribute('href', '/send/phone?again=r9');
  });

  it('W2: re-fetches on SSE reconnect (open) without waiting for a missed event', async () => {
    const sent = { ...unknown, status: 'sent', meaning: null, whatToDo: null };
    let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/requests/r9') { calls++; return new Response(JSON.stringify(calls === 1 ? sent : { ...sent, status: 'completed', receipt: 'RI9' }), { status: 200 }); }
      throw new Error(`unexpected fetch ${key}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAt('r9');
    await screen.findByText(copy.request.status.sent);
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    // No 'request.updated' event is ever emitted — only the connection's own open fires.
    es.onopen?.();
    await screen.findByText('RI9');
  });

  it('W6: shows the result source in plain English, never the raw callback/poll value', async () => {
    const completed = { ...unknown, status: 'completed', receipt: 'RI9', resultSource: 'callback', meaning: null, whatToDo: null };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/requests/r9') return new Response(JSON.stringify(completed), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    }));
    renderAt('r9');
    await screen.findByText(copy.request.status.completed);
    expect(screen.getByText(copy.request.source.callback, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('callback', { exact: true })).not.toBeInTheDocument();
  });

  it('404 shows the not-found copy under the not-found title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'That request does not exist.' } }), { status: 404 })));
    renderAt('nope');
    await screen.findByText(copy.request.notFound);
    expect(screen.getByText(copy.request.notFoundTitle)).toBeInTheDocument();
  });

  it('shows both actions for a b2c unknown row', async () => {
    const b2cUnknown = { ...unknown, pollAttempts: 1 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/requests/r9') return new Response(JSON.stringify(b2cUnknown), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    }));
    renderAt('r9');
    await screen.findByText(copy.request.status.unknown);
    expect(screen.getByRole('button', { name: copy.request.checkNow })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.request.markChecked })).toBeInTheDocument();
  });

  it('hides both actions for a non-money (status_query) unknown row', async () => {
    const lookupUnknown = { ...unknown, id: 'q9', type: 'status_query', subtype: 'lookup', pollAttempts: 1 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/requests/q9') return new Response(JSON.stringify(lookupUnknown), { status: 200 });
      throw new Error(`unexpected fetch ${key}`);
    }));
    renderAt('q9');
    await screen.findByText(copy.request.status.unknown);
    expect(screen.queryByRole('button', { name: copy.request.checkNow })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.request.markChecked })).not.toBeInTheDocument();
  });
});
