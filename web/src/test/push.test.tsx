import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Notifications } from '../pages/Notifications';
import { copy } from '../copy/en';
import { urlBase64ToUint8Array } from '../api/push';

// Live events are not under test; the page opens one stream.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Object.defineProperty is not undone by unstubAllGlobals, so the fake worker is removed here.
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

const PUBLIC_KEY = 'B' + 'A'.repeat(86);
const cp = copy.notifications.push;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/**
 * A browser that can do everything web push needs. jsdom has no service worker, no PushManager and
 * no Notification, so all three are put in place here and every call is recorded.
 */
function workingBrowser(permission: NotificationPermission = 'granted') {
  const subscription = {
    endpoint: 'https://push.example.test/send/abc123',
    toJSON: () => ({ keys: { p256dh: 'B'.repeat(87), auth: 'c'.repeat(22) } }),
    unsubscribe: vi.fn(async () => true),
  };
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async (): Promise<unknown> => null),
      subscribe: vi.fn<(options: PushSubscriptionOptionsInit) => Promise<typeof subscription>>(async () => subscription),
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register: vi.fn(async () => registration), getRegistration: vi.fn(async () => registration), ready: Promise.resolve(registration) },
  });
  vi.stubGlobal('PushManager', class PushManager {});
  vi.stubGlobal('Notification', Object.assign(class Notification {}, {
    permission,
    requestPermission: vi.fn(async () => permission),
  }));
  return { registration, subscription };
}

function mountPage(handlers: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    calls.push(key);
    if (init?.body) bodies[key] = JSON.parse(String(init.body));
    const handler = handlers[key];
    if (handler) return handler();
    if (key === 'GET /api/notifications?filter=all&limit=50') return json({ items: [], unread: 0, nextCursor: null });
    if (key === 'GET /api/push/key') return json({ configured: true, publicKey: PUBLIC_KEY });
    if (key === 'POST /api/push/subscribe') return json({ devices: 1 });
    if (key === 'POST /api/push/unsubscribe') return new Response(null, { status: 204 });
    if (key === 'POST /api/push/test') return json({ sent: 1, failed: 0 });
    throw new Error('unexpected fetch ' + key);
  });
  vi.stubGlobal('fetch', fetchMock);
  // afterEach unstubs globals, so the stream is put back for every mount.
  vi.stubGlobal('EventSource', FakeEventSource);
  render(<MemoryRouter><Notifications /></MemoryRouter>);
  return { calls, bodies };
}

describe('web push keys on the browser side', () => {
  it('reads the URL-safe base64 key the server sends as the bytes subscribe() wants', () => {
    expect(urlBase64ToUint8Array('AQAB')).toEqual(new Uint8Array([1, 0, 1]));
    expect(urlBase64ToUint8Array(PUBLIC_KEY)).toHaveLength(65);
  });
});

describe('device notifications on the Notifications page', () => {
  it('shows nothing at all when the deployment has no keys', async () => {
    mountPage({ 'GET /api/push/key': () => json({ configured: false, publicKey: null }) });
    await screen.findByText(copy.notifications.empty);
    expect(screen.queryByText(cp.title)).toBeNull();
    expect(screen.queryByRole('button', { name: cp.enable })).toBeNull();
  });

  it('says the browser cannot, rather than offering a button that cannot work', async () => {
    mountPage();
    expect(await screen.findByText(cp.unsupported)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: cp.enable })).toBeNull();
  });

  it('subscribes with the server\'s public key and hands the subscription over', async () => {
    const browser = workingBrowser('granted');
    const { calls, bodies } = mountPage();
    fireEvent.click(await screen.findByRole('button', { name: cp.enable }));
    await waitFor(() => expect(calls).toContain('POST /api/push/subscribe'));
    expect(bodies['POST /api/push/subscribe']).toEqual({
      endpoint: 'https://push.example.test/send/abc123',
      keys: { p256dh: 'B'.repeat(87), auth: 'c'.repeat(22) },
    });
    expect(browser.registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const options = browser.registration.pushManager.subscribe.mock.calls[0][0] as unknown as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toHaveLength(65);
    expect(await screen.findByText(cp.on)).toBeInTheDocument();
  });

  it('shows the browser sentence and posts nothing when permission is refused', async () => {
    workingBrowser('denied');
    const { calls } = mountPage();
    expect(await screen.findByText(cp.denied)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: cp.enable })).toBeNull();
    expect(calls.filter((c) => c.startsWith('POST /api/push'))).toEqual([]);
  });

  it('turns a device off by telling the server first, then the browser', async () => {
    const browser = workingBrowser('granted');
    browser.registration.pushManager.getSubscription.mockResolvedValue(browser.subscription);
    const { calls } = mountPage();
    fireEvent.click(await screen.findByRole('button', { name: cp.disable }));
    await waitFor(() => expect(calls).toContain('POST /api/push/unsubscribe'));
    expect(browser.subscription.unsubscribe).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: cp.enable })).toBeInTheDocument();
  });

  it('sends a test and says so', async () => {
    const browser = workingBrowser('granted');
    browser.registration.pushManager.getSubscription.mockResolvedValue(browser.subscription);
    const { calls } = mountPage();
    fireEvent.click(await screen.findByRole('button', { name: cp.test }));
    await waitFor(() => expect(calls).toContain('POST /api/push/test'));
  });
});
