import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { History } from '../pages/History';
import { copy } from '../copy/en';

afterEach(() => cleanup());

// Round 3, phase D-3: a check Studio made with Safaricom, as GET /api/requests/checks reads it.
const check = (over: Record<string, unknown> = {}) => ({
  id: 'c1', kind: 'manual', status: 'sent', said: null, meaning: null,
  askedAt: '2026-09-18T10:00:00Z', resultAt: null, askedBy: { id: 'p', displayName: 'Owner' },
  target: { requestId: 'r1', receipt: null, name: 'Jane Doe', number: '254700123456' }, ...over,
});

function stub(checks: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/requests/checks')) return new Response(JSON.stringify({ items: checks }), { status: 200 });
    if (url.includes('/api/businesses')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }));
}

describe('History › recent checks (phase D-3)', () => {
  it('lists the checks Studio made, each linking to the payment it was about', async () => {
    stub([
      check(),
      check({ id: 'c2', kind: 'lookup', status: 'completed', meaning: 'The payment went through.', target: { requestId: null, receipt: 'RI6BZTPXNM', name: null, number: null } }),
      // The sweep's own checks have nobody behind them.
      check({ id: 'c3', kind: 'sweep', status: 'completed', askedBy: null, said: 'The service request is processed successfully.', target: { requestId: null, receipt: null, name: null, number: null } }),
    ]);
    render(<MemoryRouter><History /></MemoryRouter>);
    expect(await screen.findByText(copy.history.checks.title)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: copy.history.checks.onPayment('Jane Doe') });
    expect(link).toHaveAttribute('href', '/requests/r1');
    expect(screen.getByText(copy.history.checks.onReceipt('RI6BZTPXNM'))).toBeInTheDocument();
    // A check with no answer yet says so rather than showing a blank.
    expect(screen.getByText(copy.history.checks.waiting)).toBeInTheDocument();
    expect(screen.getByText('The payment went through.')).toBeInTheDocument();
    expect(screen.getByTestId('check-c3')).toHaveTextContent(copy.history.checks.byItself);
  });

  it('draws no panel when there are no checks', async () => {
    stub([]);
    render(<MemoryRouter><History /></MemoryRouter>);
    await screen.findByText(copy.history.empty);
    expect(screen.queryByText(copy.history.checks.title)).toBeNull();
  });
});
