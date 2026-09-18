import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { CriticalAlert } from '../components/CriticalAlert';
import { ToastHost } from '../components/Toast';
import { BUZZ } from '../app/haptics';
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

const vibrate = vi.fn();
// The instances array is static, so it is emptied per test: an old instance from the previous test
// still holds that test's listener, and emitting on it would drive an unmounted component.
beforeEach(() => { Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true, writable: true }); vibrate.mockClear(); FakeEventSource.instances = []; });
afterEach(() => cleanup());

/** Round 3, phase D-8: an unread critical alert stands on every page until somebody reads it. */
const critical = { id: 'n1', severity: 'critical', category: 'operators', type: 'operator.failed', title: 'Operator problem', body: 'Safaricom refused the key.', data: {}, count: 2, readAt: null, createdAt: '2026-09-18T10:00:00Z', updatedAt: '2026-09-18T10:00:00Z' };

function mount(handlers: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><ToastHost /><CriticalAlert /></MemoryRouter>);
  return fetchMock;
}

const unread = (items: unknown[]) => () => new Response(JSON.stringify({ items, unread: items.length, nextCursor: null }), { status: 200 });

describe('an unread critical alert (phase D-8)', () => {
  it('stands on the page until it is read, with the repeat count on it', async () => {
    let posted = false;
    const fetchMock = mount({
      'GET /api/notifications?filter=unread&limit=25': () => new Response(JSON.stringify({ items: posted ? [] : [critical], unread: posted ? 0 : 1, nextCursor: null }), { status: 200 }),
      'POST /api/notifications/n1/read': () => { posted = true; return new Response(null, { status: 204 }); },
    });
    const banner = await screen.findByTestId('critical-alert');
    expect(banner).toHaveTextContent(copy.notifications.critical.title);
    expect(banner).toHaveTextContent('Operator problem ' + copy.notifications.repeated(2));
    expect(banner).toHaveTextContent(copy.notifications.critical.lead);

    fireEvent.click(screen.getByRole('button', { name: copy.notifications.critical.read }));
    await waitFor(() => expect(screen.queryByTestId('critical-alert')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/n1/read', expect.anything());
  });

  it('buzzes the device when the server reminds, and goes as soon as it is read elsewhere', async () => {
    let read = false;
    mount({ 'GET /api/notifications?filter=unread&limit=25': () => new Response(JSON.stringify({ items: read ? [] : [critical], unread: read ? 0 : 1, nextCursor: null }), { status: 200 }) });
    await screen.findByTestId('critical-alert');
    expect(vibrate).not.toHaveBeenCalled();

    // The fifteen-minute reminder arrives; the tab buzzes.
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    FakeEventSource.instances.at(-1)!.emit('notification.buzz', { type: 'notification.buzz', payload: { id: 'n1', times: 2 }, at: '2026-09-18T10:15:00Z' });
    await waitFor(() => expect(vibrate).toHaveBeenCalledWith(BUZZ.alarm));

    // Read on another screen: the next reminder finds nothing, and the line goes.
    read = true;
    FakeEventSource.instances.at(-1)!.emit('notification.buzz', { type: 'notification.buzz', payload: { id: 'n1', times: 3 }, at: '2026-09-18T10:30:00Z' });
    await waitFor(() => expect(screen.queryByTestId('critical-alert')).toBeNull());
  });

  it('draws nothing when the unread lines are not critical', async () => {
    mount({ 'GET /api/notifications?filter=unread&limit=25': unread([{ ...critical, id: 'n2', severity: 'warning' }]) });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('critical-alert')).toBeNull();
  });
});
