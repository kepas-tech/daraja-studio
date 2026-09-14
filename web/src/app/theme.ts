import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'studio.theme';
const listeners = new Set<() => void>();

export function readTheme(): Theme {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}

/** Stamps <html data-theme> for an explicit choice; "system" removes it so the media query decides. */
export function applyTheme(theme: Theme = readTheme()): void {
  const el = document.documentElement;
  if (theme === 'system') delete el.dataset.theme; else el.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  try { if (theme === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, theme); } catch { /* private mode: still applies for this page */ }
  applyTheme(theme);
  for (const l of listeners) l();
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, readTheme, () => 'system' as Theme);
  return [theme, useCallback(setTheme, [])];
}
