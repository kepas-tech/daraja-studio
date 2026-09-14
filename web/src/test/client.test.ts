import { describe, it, expect, vi } from 'vitest';
import { api, ApiError } from '../api/client';

describe('api client', () => {
  it('sends csrf on writes and surfaces error shape', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('tok');
        return new Response(JSON.stringify({ error: { code: 'step_up_required', message: 'Enter your own password to confirm.' } }), { status: 403 });
      }
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    api.setCsrf('tok');
    expect(await api.get<{ ok: number }>('/api/x')).toEqual({ ok: 1 });
    await expect(api.post('/api/y', {})).rejects.toMatchObject({ status: 403, code: 'step_up_required' } satisfies Partial<ApiError>);
  });

  it('normalises a non-JSON error body instead of throwing a raw SyntaxError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })));
    await expect(api.get('/api/z')).rejects.toMatchObject({ status: 502, code: 'bad_response' } satisfies Partial<ApiError>);
  });

  it('normalises a non-JSON 200 body the same way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>ok</html>', { status: 200 })));
    await expect(api.get('/api/z')).rejects.toMatchObject({ status: 200, code: 'bad_response' } satisfies Partial<ApiError>);
  });
});
