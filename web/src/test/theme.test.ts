import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, readTheme, setTheme } from '../app/theme';

afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; });

describe('theme', () => {
  it('follows the system by default and stamps nothing on <html>', () => {
    applyTheme();
    expect(readTheme()).toBe('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
  it('remembers an explicit choice and stamps it', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(readTheme()).toBe('dark');
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
  it('going back to system removes the stamp and the stored value', () => {
    setTheme('light');
    setTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('studio.theme')).toBeNull();
  });
});
