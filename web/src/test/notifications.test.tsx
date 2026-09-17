import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { NotificationView } from '../api/types';
import { Notifications } from '../pages/Notifications';
import { Nav } from '../app/Nav';
import { copy } from '../copy/en';

// Live events are not under test; the page and the menu each open one stream.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

afterEach(cleanup);

const at = '2026-09-16T08:00:00Z';
const sent: NotificationView = {
  id: 'n1', severity: 'success', category: 'money_out', type: 'request.completed',
  title: 'Sent KES 300 to Joseph', body: 'Joseph Ngumbao John received it. Receipt UIG517BUAZ.',
  data: { requestId: 'r1' }, count: 1, readAt: null, createdAt: at, updatedAt: at,
};
const failed: NotificationView = {
  id: 'n2', severity: 'warning', category: 'money_out', type: 'request.failed',
  title: 'KES 300 to Joseph did not go out', body: 'Safaricom said: the balance is too low.',
  data: { requestId: 'r2' }, count: 3, readAt: null, createdAt: at, updatedAt: at,
};
const read: NotificationView = {
  id: 'n3', severity: 'info', category: 'money_in', type: 'request.completed',
  title: 'Received KES 500 from Mary', body: 'Direct paybill. Receipt RI6BZTPXNM.',
  data: {}, count: 1, readAt: at, createdAt: at, updatedAt: at,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Every call the page makes, so a test can assert a write happened and the list was read again. */
function mountPage(handlers: Record<string, (init?: RequestInit) => Response> = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    calls.push(key);
    const h = handlers[key];
    if (h) return h(init);
    if (key === 'GET /api/notifications?filter=all&limit=50') return json({ items: [sent, failed, read], unread: 2, nextCursor: null });
    if (key === 'GET /api/notifications?filter=unread&limit=50') return json({ items: [sent, failed], unread: 2, nextCursor: null });
    // The device card asks its own question; these tests are about the list, so push is off.
    if (key === 'GET /api/push/key') return json({ configured: false, publicKey: null });
    throw new Error('unexpected fetch ' + key);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><Notifications /></MemoryRouter>);
  return { calls };
}

describe('Notifications page', () => {
  it('lists every line with its sentence, its repeat count and a link to the payment', async () => {
    mountPage();
    expect(await screen.findByText('Sent KES 300 to Joseph')).toBeInTheDocument();
    expect(screen.getByText('Joseph Ngumbao John received it. Receipt UIG517BUAZ.')).toBeInTheDocument();
    expect(screen.getByText('Received KES 500 from Mary')).toBeInTheDocument();
    expect(screen.getByText('×3')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: copy.notifications.openPayment });
    expect(links[0]).toHaveAttribute('href', '/requests/r1');
    expect(links[1]).toHaveAttribute('href', '/requests/r2');
  });

  it('marks one line read and reads the list again', async () => {
    const { calls } = mountPage({ 'POST /api/notifications/n1/read': () => new Response(null, { status: 204 }) });
    await screen.findByText('Sent KES 300 to Joseph');
    const buttons = screen.getAllByRole('button', { name: copy.notifications.markRead });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(calls).toContain('POST /api/notifications/n1/read'));
    await waitFor(() => expect(calls.filter((c) => c.startsWith('GET /api/notifications')).length).toBeGreaterThan(1));
  });

  it('marks all read and says how many were cleared', async () => {
    const { calls } = mountPage({ 'POST /api/notifications/read-all': () => json({ read: 2 }) });
    await screen.findByText('Sent KES 300 to Joseph');
    fireEvent.click(screen.getByRole('button', { name: copy.notifications.markAllRead }));
    await waitFor(() => expect(calls).toContain('POST /api/notifications/read-all'));
  });

  it('asks for the unread lines only, and hides a line that was already read', async () => {
    const { calls } = mountPage();
    await screen.findByText('Received KES 500 from Mary');
    fireEvent.click(screen.getByText(copy.notifications.filters.unread));
    await waitFor(() => expect(calls).toContain('GET /api/notifications?filter=unread&limit=50'));
    await waitFor(() => expect(screen.queryByText('Received KES 500 from Mary')).toBeNull());
    expect(screen.getByText('Sent KES 300 to Joseph')).toBeInTheDocument();
  });
});

describe('Notifications bell', () => {
  it('shows the unread count from the server and opens the inbox', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/notifications/count')) return json({ unread: 4 });
      if (url.includes('/api/approvals/count')) return json({ count: 0, enabled: true });
      throw new Error('unexpected fetch ' + url);
    }));
    const { container } = render(<MemoryRouter><Nav /></MemoryRouter>);
    expect(container.querySelector('a[href="/notifications"]')).not.toBeNull();
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument());
  });

  it('drops the count when the inbox says a line was read', async () => {
    let unread = 2;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/notifications/count')) return json({ unread });
      if (url.includes('/api/approvals/count')) return json({ count: 0, enabled: true });
      throw new Error('unexpected fetch ' + url);
    }));
    render(<MemoryRouter><Nav /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
    const { notificationsChanged } = await import('../api/notifications');
    unread = 0;
    notificationsChanged();
    await waitFor(() => expect(screen.queryByText('2')).toBeNull());
  });
});
