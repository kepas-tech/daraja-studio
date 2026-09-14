import type { Settings } from '../settings/store.js';
import { HttpError } from '../util/errors.js';

/**
 * Validates and normalises a candidate public URL the same way settings/service.ts's
 * setPublicUrl does (https required unless the host is localhost/127.0.0.1, no userinfo), then
 * seeds `public.url` at boot only when it actually changed. An unconditional overwrite on every
 * restart would delete a verified `public.verifiedAt` even when STUDIO_PUBLIC_URL never changed.
 */
export async function seedPublicUrl(settings: Settings, value: string): Promise<'unchanged' | 'updated'> {
  const u = new URL(value);
  if (u.username || u.password) throw new HttpError(400, 'bad_url', 'Remove the user:password part from the address.');
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new HttpError(400, 'https_required', 'The public address must start with https://');
  }
  const normalised = u.origin + u.pathname.replace(/\/+$/, '');
  const current = await settings.get('public.url');
  if (current === normalised) return 'unchanged';
  await settings.set('public.url', normalised);
  await settings.delete('public.verifiedAt');
  return 'updated';
}
