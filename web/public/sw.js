/**
 * Feature 12, second half. The service worker is deliberately tiny: it shows the line the server
 * sent and opens Studio when the line is pressed. It caches nothing — the app's own files already
 * carry the right headers, and a stale shell around live money would be worse than a wait.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Daraja Studio';
  const body = typeof data.body === 'string' ? data.body : '';
  // Only a path of our own: a push must never be able to open somewhere else.
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/notifications';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    data: { url },
    icon: '/icon-512.png',
    badge: '/favicon-32.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // An open Studio tab comes back to the front; with none open, the line's own address is opened.
    for (const client of windows) {
      if ('focus' in client) { await client.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
