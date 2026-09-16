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
/** A file the server sent: its bytes, and the name it asked for when it named one. */
export interface Download { blob: Blob; filename: string | null }

/** `attachment; filename="history-2026-09-17.csv"` -> the name; null when the server named nothing. */
function filenameFrom(header: string | null): string | null {
  const m = header ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) : null;
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Fetch a file with the session cookie. A refused export is an ordinary JSON error from the same
 * `error` envelope every route uses, so a refusal reads like any other failure instead of arriving
 * as a broken file. A body that is not JSON is the unreachable-server answer, never a download.
 */
async function download(path: string): Promise<Download> {
  const r = await fetch(path, { headers: { accept: 'text/csv' }, credentials: 'same-origin' });
  if (!r.ok) {
    const text = await r.text();
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { throw new ApiError(r.status, 'bad_response', copy.error.noReply); }
    }
    const e = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error ?? { code: 'http_' + r.status, message: copy.error.generic };
    throw new ApiError(r.status, e.code, e.message, e.details);
  }
  return { blob: await r.blob(), filename: filenameFrom(r.headers.get('content-disposition')) };
}

/**
 * Save a downloaded file the way a link carrying `download` does: a temporary object URL, one
 * click on a hidden anchor, then the URL is released. The file name the server sent wins; the
 * page's own name is only a fallback.
 */
export function saveDownload(d: Download, fallbackName: string): void {
  const url = URL.createObjectURL(d.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = d.filename ?? fallbackName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b ?? {}),
  /** Answers 204 with no body, like every DELETE in this app (contacts, 2026-09-16). */
  del: (p: string) => call<void>('DELETE', p),
  /** A CSV or other file behind the same session and permission gates as the pages. */
  download: (p: string) => download(p),
  setCsrf(t: string) { csrf = t; },
};
