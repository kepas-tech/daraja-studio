import type { Request } from 'express';
export function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** The Docker healthcheck and a local operator both connect from the loopback interface; nothing
 * further out does unless `trust proxy` was told to believe it, which is the same trust boundary
 * `clientIp` already honours. */
export function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1';
}
