import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { AccountStatement } from '../pages/AccountStatement';
import { Businesses } from '../pages/Businesses';
import { copy } from '../copy/en';
import { OTHER, RENTAL, SHIPPED_FIXTURES } from './typeFixtures';
import type { ArrearsView, BusinessView, StatementView } from '../api/types';

/**
 * Round 3, phase C: the running statement and who is behind.
 *
 * Every line is a row that exists, the only line on top says what has been paid and what is still
 * owed, and the two actions — raise the next invoice, write a reminder — are one press each. Nothing
 * here charges anybody.
 */

const state = vi.hoisted(() => ({ mayManage: true }));
vi.mock('../app/session', () => ({
  useSession: () => ({
    status: 'ready', person: { id: 'p1', is_owner: false },
    org: { id: 'o1', name: 'Test studio', shortcode: '600999', environment: 'production' },
    modules: { off: [], menuOff: [] },
    permissions: state.mayManage ? ['businesses.manage', 'invoices.manage'] : [],
    refresh: async () => {},
  }),
}));
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => { cleanup(); state.mayManage = true; });

const at = '2026-09-17T08:00:00Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const view = (over: Partial<StatementView> = {}): StatementView => ({
  account: { id: 'a1', name: 'Jane', fullNumber: '001359', phone: '254700123456', note: null, businessId: 'b1', businessName: 'White House', businessCode: '001', parentId: null },
  type: RENTAL,
  standingCents: 1_000_000,
  schedule: { regular: 'monthly', standingAmount: 'fixed', periodsDue: 3, expectedCents: 3_000_000 },
  paidInCents: 1_000_000, paidOutCents: 200000,
  invoicedCents: 1_000_000, unpaidInvoiceCents: 1_000_000, unpaidInvoiceCount: 1,
  owedCents: 2_000_000, behindPeriods: 2, lastRemindedAt: null,
  rows: [
    { at: '2026-09-01T08:00:00Z', kind: 'in', label: 'Pay Bill', amountCents: 1_000_000, status: 'completed', receipt: 'RKT1234567', reference: null, accountName: null, requestId: 'r1', invoiceId: null },
    { at: '2026-09-02T08:00:00Z', kind: 'invoice', label: 'September 2026', amountCents: 1_000_000, status: 'sent', receipt: null, reference: 'INV-000001', accountName: null, requestId: null, invoiceId: 'i1' },
    { at: '2026-09-03T08:00:00Z', kind: 'out', label: 'BusinessPayment', amountCents: 200000, status: 'sent', receipt: null, reference: null, accountName: null, requestId: 'r2', invoiceId: null },
  ],
  ...over,
});

function mountStatement(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={['/accounts/a1']}><Routes><Route path="/accounts/:id" element={<AccountStatement />} /></Routes></MemoryRouter>);
}

describe('the account statement', () => {
  it('reads paid to date and still owed on top, then every real row oldest first', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return json(view()); });
    mountStatement(fetchMock);
    // The one plain line on top.
    expect(await screen.findByTestId('statement-line')).toHaveTextContent(copy.statement.line('KES 10,000', 'KES 20,000'));
    // The kind's own words, the account number and the business.
    expect(screen.getByText(copy.statement.subtitle('Rent statement', '001359', 'White House'))).toBeInTheDocument();
    // The schedule: what each period expects, and what is behind.
    expect(screen.getByTestId('statement-behind')).toHaveTextContent(copy.statement.behind(2));
    expect(screen.getByText(copy.statement.expected('KES 10,000', 3))).toBeInTheDocument();
    // Three rows, oldest first, each linking to its own row.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText(copy.statement.in)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(copy.statement.invoice)).toBeInTheDocument();
    expect(within(rows[2]!).getByText(copy.statement.out)).toBeInTheDocument();
    expect(urls[0]).toBe('/api/accounts/a1/statement');
  });

  it('raises the next invoice on one press, and writes a reminder on another', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      calls.push(key);
      if (key === 'GET /api/accounts/a1/statement') return json(view());
      if (key === 'POST /api/accounts/a1/next-invoice') return json({ id: 'i2', reference: 'INV-000002' }, 201);
      if (key === 'POST /api/accounts/a1/remind') return json({ message: 'Hello Jane, September 2026 is still outstanding: KES 20,000. Pay to White House, account 001359.', phone: '254700123456' });
      throw new Error('unexpected fetch ' + key);
    });
    mountStatement(fetchMock);
    fireEvent.click(await screen.findByRole('button', { name: copy.statement.raise }));
    await waitFor(() => expect(calls).toContain('POST /api/accounts/a1/next-invoice'));
    // The statement is read again after the press, so the new invoice is on it.
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/accounts/a1/statement').length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole('button', { name: copy.statement.remind }));
    await waitFor(() => expect(calls).toContain('POST /api/accounts/a1/remind'));
    const draft = await screen.findByTestId('reminder');
    expect(draft).toHaveTextContent('Hello Jane');
    // The owner sends it: the message opens in their own phone, and Studio says so.
    expect(within(draft).getByRole('link', { name: copy.statement.sendByPhone })).toHaveAttribute('href', expect.stringContaining('sms:254700123456'));
    expect(draft).toHaveTextContent(copy.statement.reminderHint);
  });

  it('says there is nothing to be behind on when the kind expects nothing regular', async () => {
    const shop = view({ type: OTHER, standingCents: null, schedule: { regular: 'no', standingAmount: 'none', periodsDue: 0, expectedCents: null }, owedCents: 0, behindPeriods: 0, rows: [] });
    mountStatement(vi.fn(async () => json(shop)));
    expect(await screen.findByTestId('no-arrears')).toHaveTextContent(copy.statement.noArrearsHere);
    expect(screen.queryByRole('button', { name: copy.statement.raise })).toBeNull();
    expect(screen.getByText(copy.statement.empty)).toBeInTheDocument();
  });
});

describe('who is behind, on the Businesses page', () => {
  const business: BusinessView = { id: 'b1', code: '001', name: 'White House', active: true, accountCount: 2, numbers: { width: 3, capacity: 900, used: 2 }, createdAt: at, type: RENTAL };
  const arrears: ArrearsView = {
    businessId: 'b1', businessName: 'White House', businessCode: '001', type: RENTAL, hasArrears: true,
    behindCount: 1, owedCents: 3_000_000,
    rows: [
      { accountId: 'a1', name: 'Cynthia', fullNumber: '001400', standingCents: 1_000_000, periodsDue: 3, expectedCents: 3_000_000, paidInCents: 0, owedCents: 3_000_000, behindPeriods: 3, lastRemindedAt: null, oldestInvoice: { id: 'i1', reference: 'INV-000009', billedPeriod: 'September 2026', dueDate: '2026-09-30', amountCents: 1_000_000, paidCents: 0 } },
      { accountId: 'a2', name: 'Amina', fullNumber: '001401', standingCents: 500_000, periodsDue: 3, expectedCents: 1_500_000, paidInCents: 1_500_000, owedCents: 0, behindPeriods: 0, lastRemindedAt: '2026-09-16T08:00:00Z', oldestInvoice: null },
    ],
  };

  it('lists each account with how far behind it is, and links to its statement', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/businesses') return json({ items: [business], lastUsedId: null });
      if (url === '/api/business-types') return json({ items: SHIPPED_FIXTURES });
      if (url === '/api/businesses/b1/arrears') return json(arrears);
      throw new Error('unexpected fetch ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Businesses /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: copy.statement.who }));
    const panel = await screen.findByTestId('arrears-b1');
    expect(panel).toHaveTextContent(copy.statement.whoTotal('KES 30,000', 1));
    expect(within(panel).getByTestId('arrears-row-a1')).toHaveTextContent(copy.statement.behind(3));
    expect(within(panel).getByTestId('arrears-row-a1')).toHaveTextContent(copy.statement.oldest('INV-000009', 'September 2026'));
    expect(within(panel).getByTestId('arrears-row-a2')).toHaveTextContent(copy.statement.upToDate);
    expect(within(panel).getByRole('link', { name: 'Cynthia' })).toHaveAttribute('href', '/accounts/a1');
  });
});
