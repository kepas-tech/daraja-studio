/**
 * The inbox changed under the bell's feet: a line was read, or all of them were. The menu lives
 * outside the page, so the page says so on the window the way Toast does, and the bell re-reads its
 * count. It is not a second state store: the count is always read from the server, never counted
 * here.
 */
export const NOTIFICATIONS_CHANGED = 'studio:notifications-changed';

export function notificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
}
