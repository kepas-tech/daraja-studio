import { describe, it, expect, vi } from 'vitest';

const timingSafeEqualSpy = vi.hoisted(() => vi.fn());

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => {
      timingSafeEqualSpy(a, b);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { requireCsrf } = await import('../src/auth/middleware.js');

function mockReq(method: string, csrf: string | undefined, sent: string | undefined) {
  return { method, csrf, get: (name: string) => (name.toLowerCase() === 'x-csrf-token' ? sent : undefined) } as never;
}

describe('requireCsrf', () => {
  it('accepts a matching token', () => {
    const next = vi.fn();
    requireCsrf(mockReq('POST', 'abc123', 'abc123'), {} as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('compares equal-length tokens with a constant-time comparison, not ===', () => {
    timingSafeEqualSpy.mockClear();
    const next = vi.fn();
    requireCsrf(mockReq('POST', 'abc123', 'abc123'), {} as never, next);
    expect(timingSafeEqualSpy).toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a same-length but different token', () => {
    const next = vi.fn();
    requireCsrf(mockReq('POST', 'abc123', 'xyz987'), {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403, code: 'csrf' }));
  });

  it('rejects a different-length token without throwing (and without calling timingSafeEqual on mismatched lengths)', () => {
    timingSafeEqualSpy.mockClear();
    const next = vi.fn();
    expect(() => requireCsrf(mockReq('POST', 'abc123', 'ab'), {} as never, next)).not.toThrow();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403, code: 'csrf' }));
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('lets GET/HEAD/OPTIONS through with no token at all', () => {
    const next = vi.fn();
    requireCsrf(mockReq('GET', 'abc123', undefined), {} as never, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects when there is no session csrf token at all', () => {
    const next = vi.fn();
    requireCsrf(mockReq('POST', undefined, 'abc123'), {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403, code: 'csrf' }));
  });
});
