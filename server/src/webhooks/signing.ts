import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Round 3, phase E: what signs a webhook, and how the receiver checks it.
 *
 * The shape is the one Stripe made familiar, so a receiver can lift an existing verifier:
 *
 *   X-Studio-Signature: t=1730297821,v1=<hex hmac-sha256>
 *   signed text:       `${t}.${rawBody}`
 *
 * Signing the timestamp with the body is what gives the receiver replay protection: two identical
 * events at different times sign differently, and a signature older than the tolerance can be
 * refused. The secret is the organisation's own and is never logged, never put in an audit row and
 * never echoed back to a caller.
 */
export const SIGNATURE_HEADER = 'x-studio-signature';
export const EVENT_HEADER = 'x-studio-event';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signWebhook(rawBody: string, secret: string, now: Date = new Date()): { header: string; timestamp: number; signature: string } {
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { header: `t=${timestamp},v1=${signature}`, timestamp, signature };
}

export function verifyWebhook(input: { rawBody: string; secret: string; header: string; toleranceSeconds?: number; now?: Date }): boolean {
  const parts = new Map(input.header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1') ?? '';
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - t) > tolerance) return false;
  const expected = createHmac('sha256', input.secret).update(`${t}.${input.rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * A public https address and nothing else: never a loopback, a private range or a URL carrying
 * credentials. A webhook posts this studio's own data to wherever the owner says, so the owner is
 * not allowed to point it at the server it is running on.
 */
export function checkWebhookUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'That is not a web address.' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'The address must start with https://' };
  if (u.username || u.password) return { ok: false, reason: 'Take the username and password out of the address.' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: 'That address is inside the network, not on the internet.' };
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const privateish = a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
    if (privateish) return { ok: false, reason: 'That address is inside the network, not on the internet.' };
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return { ok: false, reason: 'That address is inside the network, not on the internet.' };
  }
  return { ok: true };
}
