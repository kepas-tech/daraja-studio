import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Bulk, BulkDetail } from '../pages/Bulk';
import { copy } from '../copy/en';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}
const rows = [{ line: 1, phone: '254700123456', amountCents: 10000, name: 'Jane', note: null }, { line: 2, phone: '254700123457', amountCents: 20000, name: null, note: null }];
const plan = { id: 'b1', category: null, rowCount: 2, totalCents: 30000, status: 'done', createdAt: '2026-09-16T07:00:00Z', finishedAt: '2026-09-16T07:01:00Z', createdBy: { id: 'p', displayName: 'Owner' }, rows: rows.map((r, index) => ({ ...r, index, result: { requestId: `r${index}`, status: 'sent' }, receipt: index === 0 ? 'RI1' : null, liveStatus: index === 0 ? 'completed' : 'failed' })) };

describe('Bulk send', () => {
  it('checks the pasted list, shows problems, and only offers Send when clean', async () => {
    let checked = 0;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/send/bulk': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      'GET /api/send/categories': () => new Response(JSON.stringify({ items: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }] }), { status: 200 }),
      'POST /api/send/bulk/check': () => { checked += 1; return new Response(JSON.stringify(checked === 1
        ? { rows, errors: [{ line: 3, message: 'Not a Kenyan mobile number.' }], count: 2, totalCents: 30000 }
        : { rows, errors: [], count: 2, totalCents: 30000 }), { status: 200 }); },
    }));
    render(<MemoryRouter><Bulk /></MemoryRouter>);
    await screen.findByText(copy.bulk.none);
    fireEvent.change(screen.getByLabelText(copy.bulk.paste), { target: { value: '0700123456,100\nbad,1' } });
    fireEvent.click(screen.getByRole('button', { name: copy.bulk.check }));
    await screen.findByText(copy.bulk.problems(1));
    expect(screen.getByText(/Line 3:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.bulk.send })).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.bulk.paste), { target: { value: '0700123456,100' } });
    fireEvent.click(screen.getByRole('button', { name: copy.bulk.check }));
    await screen.findByText(copy.bulk.ok(2, 'KES 300'));
    expect(screen.getByRole('button', { name: copy.bulk.send })).toBeInTheDocument();
  });

  it('sending asks for the password, posts the list, and opens the batch', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/send/bulk': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      'GET /api/send/categories': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      'POST /api/send/bulk/check': () => new Response(JSON.stringify({ rows, errors: [], count: 2, totalCents: 30000 }), { status: 200 }),
      'POST /api/send/bulk': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ ...plan, status: 'sending' }), { status: 201 }); },
      'GET /api/send/bulk/b1': () => new Response(JSON.stringify({ ...plan, status: 'sending' }), { status: 200 }),
    }));
    render(<MemoryRouter initialEntries={['/bulk']}><Routes><Route path="/bulk" element={<Bulk />} /><Route path="/bulk/:id" element={<BulkDetail />} /></Routes></MemoryRouter>);
    await screen.findByText(copy.bulk.none);
    fireEvent.change(screen.getByLabelText(copy.bulk.paste), { target: { value: '0700123456,100\n0700123457,200' } });
    fireEvent.click(screen.getByRole('button', { name: copy.bulk.check }));
    await screen.findByRole('button', { name: copy.bulk.send });
    fireEvent.click(screen.getByRole('button', { name: copy.bulk.send }));
    await screen.findByText(copy.bulk.confirm(2, 'KES 300'));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toEqual({ text: '0700123456,100\n0700123457,200', category: undefined, password: 'pw' }));
    await screen.findByText(copy.bulk.status.sending);
  });

  it('the batch page shows each row with its live status and receipt', async () => {
    vi.stubGlobal('fetch', fetchFor({ 'GET /api/send/bulk/b1': () => new Response(JSON.stringify(plan), { status: 200 }) }));
    render(<MemoryRouter initialEntries={['/bulk/b1']}><Routes><Route path="/bulk/:id" element={<BulkDetail />} /></Routes></MemoryRouter>);
    await screen.findByText('RI1');
    expect(screen.getByText(copy.request.status.completed)).toBeInTheDocument();
    expect(screen.getByText(copy.request.status.failed)).toBeInTheDocument();
    expect(screen.getByText(copy.bulk.download)).toBeInTheDocument();
  });
});
