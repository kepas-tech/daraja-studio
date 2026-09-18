import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Deliveries } from '../pages/Deliveries';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

afterEach(() => cleanup());

/** Round 3, phase E: the deliveries page — tries, what the address said, and the next attempt. */
const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'd1', event: 'request.completed', url: 'https://example.test/hooks/studio', requestId: 'r1',
  attempts: 1, lastStatus: 200, lastResponse: 'ok',
  lastTryAt: '2026-09-18T10:00:00Z', nextRetryAt: null, deliveredAt: '2026-09-18T10:00:00Z',
  createdAt: '2026-09-18T09:59:00Z', state: 'delivered', ...over,
});

function mount(handlers: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const k = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[k];
    if (!h) throw new Error(`unexpected fetch ${k}`);
    return h(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><ToastHost /><Deliveries /></MemoryRouter>);
  return fetchMock;
}

describe('Deliveries (phase E)', () => {
  it('shows every delivery with its tries, answer and next attempt, and retries the ones that need it', async () => {
    let retried = false;
    const pending = delivery({ id: 'd2', event: 'request.failed', state: 'pending', attempts: 2, lastStatus: 500, lastResponse: 'Internal Server Error', deliveredAt: null, nextRetryAt: '2026-09-18T11:00:00Z' });
    const failed = delivery({ id: 'd3', event: 'request.unknown', state: 'failed', attempts: 6, lastStatus: null, lastResponse: 'network_error: TimeoutError', deliveredAt: null, nextRetryAt: null });
    mount({
      'GET /api/webhooks/deliveries?state=all&limit=50': () => new Response(JSON.stringify({ items: [delivery(), pending, failed] }), { status: 200 }),
      'POST /api/webhooks/deliveries/d3/retry': () => { retried = true; return new Response(JSON.stringify({ ...failed, state: 'pending', nextRetryAt: '2026-09-18T12:00:00Z' }), { status: 200 }); },
    });

    const delivered = await screen.findByTestId('delivery-d1');
    expect(delivered).toHaveTextContent('request.completed');
    expect(delivered).toHaveTextContent('200');
    expect(delivered).toHaveTextContent(copy.deliveries.deliveredAt('18 Sept 2026, 13:00'));

    const waiting = screen.getByTestId('delivery-d2');
    expect(waiting).toHaveTextContent('Internal Server Error');
    expect(waiting).toHaveTextContent(copy.deliveries.nextAt('18 Sept 2026, 14:00'));
    expect(screen.getByTestId('delivery-d3')).toHaveTextContent(copy.deliveries.gaveUp);

    // Only the two that have not been delivered offer a retry.
    const buttons = screen.getAllByRole('button', { name: copy.deliveries.retry });
    expect(buttons).toHaveLength(2);
    fireEvent.click(within(screen.getByTestId('delivery-d3')).getByRole('button', { name: copy.deliveries.retry }));
    await waitFor(() => expect(retried).toBe(true));
    expect(await screen.findByText(copy.deliveries.retried)).toBeInTheDocument();
  });

  it('narrows to one state, and says when there is nothing in it', async () => {
    const urls: string[] = [];
    mount({
      'GET /api/webhooks/deliveries?state=all&limit=50': () => { urls.push('all'); return new Response(JSON.stringify({ items: [delivery()] }), { status: 200 }); },
      'GET /api/webhooks/deliveries?state=failed&limit=50': () => { urls.push('failed'); return new Response(JSON.stringify({ items: [] }), { status: 200 }); },
    });
    await screen.findByTestId('delivery-d1');
    fireEvent.click(screen.getByLabelText(copy.deliveries.states.failed!));
    expect(await screen.findByText(copy.deliveries.empty.failed!)).toBeInTheDocument();
    expect(urls).toEqual(['all', 'failed']);
    await waitFor(() => expect(screen.queryByTestId('delivery-d1')).toBeNull());
  });
});
