import { api } from './client';

export interface PushKeyAnswer { configured: boolean; publicKey: string | null }
export interface PushTestAnswer { sent: number; failed: number }

/** Whether this browser can do web push at all. */
export function supported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
}

/** 'unsupported' is the honest answer on a browser that cannot be asked. */
export function permission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

/**
 * subscribe() wants bytes while the server sends the key as base64url, so the padding atob insists
 * on is put back and the two URL-safe characters are mapped to their ordinary ones.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The server's public half, and whether the deployment has one at all. */
export function key(): Promise<PushKeyAnswer> {
  return api.get<PushKeyAnswer>('/api/push/key');
}

/** Is this browser already subscribed? A missing worker or a refused one is simply "no". */
export async function subscribedHere(): Promise<boolean> {
  if (!supported()) return false;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return !!(await registration?.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Ask the browser, register the worker, subscribe with the server's public key, then hand the
 * subscription to the server. 'refused' means the person (or the browser's own setting) said no;
 * nothing was posted, so nothing was stored.
 */
export async function turnOn(publicKey: string): Promise<'on' | 'refused'> {
  const allowed = await Notification.requestPermission();
  if (allowed !== 'granted') return 'refused';
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = subscription.toJSON() as { keys?: { p256dh?: string; auth?: string } };
  await api.post('/api/push/subscribe', {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  });
  return 'on';
}

/** Tell the server first, then the browser: a row left behind is a push to a device whose person said no. */
export async function turnOff(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/** One line to this device only, so the person can see that it works. */
export function sendTest(): Promise<PushTestAnswer> {
  return api.post<PushTestAnswer>('/api/push/test');
}
