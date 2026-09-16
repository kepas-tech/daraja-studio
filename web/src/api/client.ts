import { copy } from '../copy/en';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
let csrf = '';
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { throw new ApiError(r.status, 'bad_response', copy.error.noReply); }
  }
  if (!r.ok) {
    const e = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error ?? { code: 'http_' + r.status, message: copy.error.generic };
    throw new ApiError(r.status, e.code, e.message, e.details);
  }
  return data as T;
}
export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b ?? {}),
  setCsrf(t: string) { csrf = t; },
};
