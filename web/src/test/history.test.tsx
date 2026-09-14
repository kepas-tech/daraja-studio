import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { History } from '../pages/History';
import { copy } from '../copy/en';

afterEach(() => cleanup());
const row = (id: string, status: string) => ({ id, type: 'b2c', subtype: 'BusinessPayment', status, amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: null, receipt: status === 'completed' ? `RI${id}` : null, createdAt: '2026-09-06T11:00:00Z', sentAt: null, resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' } });

describe('History', () => {
  it('lists, filters and loads more', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url.includes('cursor=c1')) return new Response(JSON.stringify({ items: [row('3', 'failed')], nextCursor: null }), { status: 200 });
      if (url.includes('status=failed')) return new Response(JSON.stringify({ items: [row('3', 'failed')], nextCursor: null }), { status: 200 });
      return new Response(JSON.stringify({ items: [row('1', 'completed'), row('2', 'sent')], nextCursor: 'c1' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><History /></MemoryRouter>);
    await screen.findByText('RI1');
    expect(screen.getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: copy.history.loadMore }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4));
    expect(screen.queryByRole('button', { name: copy.history.loadMore })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.history.status), { target: { value: 'failed' } });
    await waitFor(() => expect(urls.some((u) => u.includes('status=failed'))).toBe(true));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    expect(screen.getByRole('link', { name: /0700 123 456/ })).toHaveAttribute('href', '/requests/3');
  });

  it('shows the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })));
    render(<MemoryRouter><History /></MemoryRouter>);
    await screen.findByText(copy.history.empty);
  });
});
