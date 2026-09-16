import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { History } from '../pages/History';
import { Invoices } from '../pages/Invoices';
import { copy } from '../copy/en';

// The pages ask the session who may export; nothing else about it is under test here.
const state = vi.hoisted(() => ({ mayExport: true }));
vi.mock('../app/session', () => ({
  useSession: () => ({
    status: 'ready', person: { id: 'p1', display_name: 'Amina', is_owner: false },
    org: { id: 'o1', name: 'Test studio', shortcode: '600999', environment: 'production' },
    permissions: state.mayExport ? ['history.export'] : [],
    refresh: async () => {},
  }),
}));

class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const csv = (name: string) => new Response('a,b\r\n1,2\r\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${name}"` } });

/** The name each saved file was given; jsdom cannot download, so the click is watched. */
let saved: string[] = [];

beforeEach(() => {
  saved = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => 'blob:test');
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
});
afterEach(() => { cleanup(); state.mayExport = true; vi.restoreAllMocks(); });

function mountHistory(opts: { exportResponse?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = (init?.method ?? 'GET') + ' ' + url;
    if (url.startsWith('/api/requests/export.csv')) return (opts.exportResponse ?? (() => csv('history-2026-09-17.csv')))();
    if (url.startsWith('/api/requests?')) return json({ items: [], nextCursor: null });
    if (url === '/api/businesses') return json({ items: [] });
    throw new Error('unexpected fetch ' + key);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><History /></MemoryRouter>);
  return fetchMock;
}

const settings = {
  mode: 'production', optedIn: true, optedInAt: '2026-09-01T00:00:00Z', email: 'owner@example.com',
  phone: '254700000000', reminders: true, publicVerified: true, registering: false, lastError: null,
};

function mountInvoices(opts: { exportResponse?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = (init?.method ?? 'GET') + ' ' + url;
    if (url.startsWith('/api/invoices/export.csv')) return (opts.exportResponse ?? (() => csv('invoices-2026-09-17.csv')))();
    if (url === '/api/invoices/settings') return json(settings);
    if (url.startsWith('/api/invoices?')) return json({ items: [] });
    throw new Error('unexpected fetch ' + key);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><Invoices /></MemoryRouter>);
  return fetchMock;
}

describe('Export as a spreadsheet', () => {
  it('is absent from History without the permission and present with it', async () => {
    state.mayExport = false;
    mountHistory();
    expect(screen.queryByRole('button', { name: copy.history.export })).toBeNull();
    cleanup();
    state.mayExport = true;
    mountHistory();
    expect(await screen.findByRole('button', { name: copy.history.export })).toBeInTheDocument();
  });

  it('sends every filter on the History page, not the page of rows', async () => {
    const fetchMock = mountHistory();
    fireEvent.change(screen.getByLabelText(copy.history.search), { target: { value: 'ACME' } });
    fireEvent.change(screen.getByLabelText(copy.history.status), { target: { value: 'failed' } });
    fireEvent.click(await screen.findByRole('button', { name: copy.history.export }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/requests/export.csv?q=ACME&status=failed', expect.anything()));
    // The server named the file; that name is the one used.
    await waitFor(() => expect(saved).toEqual(['history-2026-09-17.csv']));
  });

  it('shows the explained error when the export is refused, and saves nothing', async () => {
    mountHistory({ exportResponse: () => json({ error: { code: 'forbidden', message: 'You do not have permission to export history.' } }, 403) });
    fireEvent.click(await screen.findByRole('button', { name: copy.history.export }));
    expect(await screen.findByText('You do not have permission to export history.')).toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it('sends the Invoices filter and search, and saves the file the server named', async () => {
    const fetchMock = mountInvoices();
    fireEvent.change(await screen.findByLabelText(copy.invoices.search), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText(copy.invoices.filter), { target: { value: 'paid' } });
    fireEvent.click(screen.getByRole('button', { name: copy.invoices.export }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/invoices/export.csv?filter=paid&q=Jane', expect.anything()));
    await waitFor(() => expect(saved).toEqual(['invoices-2026-09-17.csv']));
  });
});
