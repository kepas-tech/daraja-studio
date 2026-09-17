import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Reports } from '../pages/Reports';
import { Home } from '../pages/Home';
import { copy } from '../copy/en';

// The pages ask the session who may export and who is looking; nothing else about it is under test.
const state = vi.hoisted(() => ({ mayExport: true }));
vi.mock('../app/session', () => ({
  useSession: () => ({
    status: 'ready',
    person: { id: 'p1', username: 'amina', display_name: 'Amina', is_owner: false, must_change_password: false },
    org: { id: 'o1', name: 'Test studio', shortcode: '600999', environment: 'production', status: 'verified', isHost: false, suspendReason: null, shortcodeKind: 'paybill' },
    permissions: state.mayExport ? ['history.export'] : [],
    refresh: async () => {},
  }),
}));

class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const csv = (name: string) => new Response('Day,Money in\r\n2026-09-16,5000\r\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${name}"` } });

/** The name each saved file was given; jsdom cannot download, so the click is watched. */
let saved: string[] = [];
beforeEach(() => {
  saved = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => 'blob:test');
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
});
afterEach(() => { cleanup(); state.mayExport = true; vi.restoreAllMocks(); });

const businesses = [
  { id: 'b1', code: '000', name: 'Main shop', active: true, customerCount: 3, createdAt: '2026-09-01T00:00:00Z' },
  { id: 'b2', code: '001', name: 'Second shop', active: true, customerCount: 1, createdAt: '2026-09-02T00:00:00Z' },
];

/** Two days: one with money both ways and a failure, one with nothing at all. */
const view = (days: number) => ({
  window: { days, from: '2026-09-11', to: '2026-09-17' },
  days: [
    { day: '2026-09-16', inCents: 500000, inCount: 2, outCents: 30000, outCount: 1, completed: 2, failed: 1, unknown: 1 },
    { day: '2026-09-17', inCents: 0, inCount: 0, outCents: 0, outCount: 0, completed: 0, failed: 0, unknown: 0 },
  ],
  totals: { inCents: 500000, inCount: 2, outCents: 30000, outCount: 1, completed: 2, failed: 1, unknown: 1 },
  failures: [{ reason: 'The balance is insufficient.', count: 1, amountCents: 30000 }],
  byBusiness: [{ businessId: 'b1', code: '000', name: 'Main shop', inCents: 500000, outCents: 30000 }],
});

function mountReports(opts: { items?: unknown[]; viewResponse?: () => Response; exportResponse?: () => Response } = {}) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); urls.push(url);
    if (url.startsWith('/api/reports/export.csv')) return (opts.exportResponse ?? (() => csv('reports-2026-09-17.csv')))();
    if (url.startsWith('/api/reports?')) return (opts.viewResponse ?? (() => json(view(Number(new URLSearchParams(url.split('?')[1]).get('days') ?? 7)))))();
    if (url === '/api/businesses') return json({ items: opts.items ?? [] });
    throw new Error('unexpected fetch ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><Reports /></MemoryRouter>);
  return { fetchMock, urls };
}

describe('Reports', () => {
  it('shows the window, the totals, one line per day and why things failed', async () => {
    const { urls } = mountReports({ items: businesses });
    const row = await screen.findByTestId('report-day-2026-09-16');
    expect(urls.find((u) => u.startsWith('/api/reports?'))).toContain('days=7');
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('KES 5,000');
    expect(cells[2]).toHaveTextContent('2');
    expect(cells[5]).toHaveTextContent('2');
    expect(cells[6]).toHaveTextContent('1');
    expect(cells[7]).toHaveTextContent('1');
    // A day with nothing is still a line, so a gap in trade reads as a gap.
    expect(screen.getByTestId('report-day-2026-09-17')).toHaveTextContent('KES 0');
    // The rate names the two numbers it is made of: two paid, one failed, 67%.
    expect(screen.getByText(/67% of finished payments went through/)).toBeInTheDocument();
    expect(screen.getByText(copy.reports.rateNote)).toBeInTheDocument();
    // Failed rows grouped by Safaricom's own reason, with the money they affected.
    expect(screen.getByRole('heading', { name: copy.reports.failuresTitle })).toBeInTheDocument();
    const failure = screen.getByText('The balance is insufficient.').closest('tr');
    expect(failure).toHaveTextContent('KES 300');
    // More than one business, so each one's own in and out for the window.
    expect(screen.getByRole('heading', { name: copy.reports.byBusiness })).toBeInTheDocument();
    expect(screen.getByTestId('report-business-b1')).toHaveTextContent('Main shop');
  });

  it('re-asks with the window and the business the owner picks', async () => {
    const { urls } = mountReports({ items: businesses });
    await screen.findByTestId('report-day-2026-09-16');
    fireEvent.click(screen.getByLabelText(copy.reports.windows[30]));
    await waitFor(() => expect(urls.some((u) => u.includes('days=30'))).toBe(true));
    fireEvent.change(screen.getByLabelText(copy.reports.business), { target: { value: 'b2' } });
    await waitFor(() => expect(urls.some((u) => u.includes('days=30') && u.includes('businessId=b2'))).toBe(true));
  });

  it('offers no business filter when there is only one business', async () => {
    mountReports({ items: [businesses[0]] });
    await screen.findByTestId('report-day-2026-09-16');
    expect(screen.queryByLabelText(copy.reports.business)).toBeNull();
  });

  it('shows the explained error instead of a blank page when the numbers cannot be read', async () => {
    mountReports({ viewResponse: () => json({ error: { code: 'internal', message: 'Something went wrong on our side. Try again in a moment.' } }, 500) });
    expect(await screen.findByText('Something went wrong on our side. Try again in a moment.')).toBeInTheDocument();
  });
});

describe('Reports export', () => {
  it('is absent without the permission and present with it', async () => {
    state.mayExport = false;
    mountReports();
    await screen.findByTestId('report-day-2026-09-16');
    expect(screen.queryByRole('button', { name: copy.reports.export })).toBeNull();
    cleanup();
    state.mayExport = true;
    mountReports();
    expect(await screen.findByRole('button', { name: copy.reports.export })).toBeInTheDocument();
  });

  it('sends the chosen window and saves the file the server named', async () => {
    const { fetchMock } = mountReports();
    await screen.findByTestId('report-day-2026-09-16');
    fireEvent.click(screen.getByLabelText(copy.reports.windows[90]));
    fireEvent.click(screen.getByRole('button', { name: copy.reports.export }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/reports/export.csv?days=90', expect.anything()));
    await waitFor(() => expect(saved).toEqual(['reports-2026-09-17.csv']));
  });

  it('shows the refusal and saves nothing', async () => {
    mountReports({ exportResponse: () => json({ error: { code: 'forbidden', message: 'You do not have permission to export history.' } }, 403) });
    await screen.findByTestId('report-day-2026-09-16');
    fireEvent.click(screen.getByRole('button', { name: copy.reports.export }));
    expect(await screen.findByText('You do not have permission to export history.')).toBeInTheDocument();
    expect(saved).toEqual([]);
  });
});

describe('Home 24-hour strip', () => {
  it('shows what came in and went out in the last day, and what is waiting or failed', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/settings') return json({ mode: 'production' });
      if (url === '/api/balances/latest') return json({ workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: '2026-09-17T00:00:00Z' });
      if (url.startsWith('/api/requests')) return json({ items: [], nextCursor: null });
      if (url === '/api/businesses/summary') return json({ items: [] });
      if (url === '/api/reports/summary') return json({ inCents: 500000, inCount: 2, outCents: 30000, outCount: 1, pending: 3, failed: 1 });
      throw new Error('unexpected fetch ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Home /></MemoryRouter>);
    const strip = await screen.findByTestId('home-today');
    expect(strip).toHaveTextContent(copy.home.today.last24h);
    expect(strip).toHaveTextContent(copy.home.today.in('KES 5,000', 2));
    expect(strip).toHaveTextContent(copy.home.today.out('KES 300', 1));
    expect(strip).toHaveTextContent(copy.home.today.waiting(3));
    expect(strip).toHaveTextContent(copy.home.today.failed(1));
  });
});
