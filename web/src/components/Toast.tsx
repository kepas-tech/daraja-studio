import { useEffect, useState } from 'react';
import { copy } from '../copy/en';

export type ToastKind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; text: string }

const DURATIONS: Record<ToastKind, number> = { success: 4000, error: 8000, info: 4000 };
const MAX_VISIBLE = 3;
const EVENT = 'daraja-studio:toast';
let nextId = 1;

// A `window` event rather than React context or a module-level store: `useToast()` must work
// from any page with no provider to wrap it, `ToastHost()` (a leaf component, no children) is
// the only thing that renders the current list, and each mount of it starts with its own empty
// state — nothing to leak between tests, or between an unmounted host and the next one.
function show(kind: ToastKind, text: string): number {
  const id = nextId++;
  window.dispatchEvent(new CustomEvent<ToastItem>(EVENT, { detail: { id, kind, text } }));
  return id;
}

// None of these close over component state, so the returned object is a stable module-level
// constant rather than a fresh one per render — callers that put it (or one of its methods) in a
// useCallback/useEffect dependency array must not have that dependency change identity on every
// render as a side effect of just calling this hook.
const toastApi = {
  show,
  success: (text: string) => show('success', text),
  error: (text: string) => show('error', text),
  info: (text: string) => show('info', text),
};
export function useToast() {
  return toastApi;
}

function ToastRow({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDismiss(item.id), DURATIONS[item.kind]);
    return () => clearTimeout(t);
  }, [item.id, item.kind, paused, onDismiss]);
  const tone = item.kind === 'error' ? 'bg-red-700 text-white' : item.kind === 'success' ? 'bg-emerald-700 text-white dark:bg-emerald-600' : 'bg-gray-800 text-white dark:bg-gray-700';
  return (
    <div
      role={item.kind === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex w-full max-w-sm items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm shadow-lg ${tone}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span>{item.text}</span>
      <button type="button" aria-label={copy.toast.close} className="shrink-0 text-lg leading-none opacity-80 hover:opacity-100" onClick={() => onDismiss(item.id)}>×</button>
    </div>
  );
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = (id: number) => setItems((prev) => prev.filter((t) => t.id !== id));
  useEffect(() => {
    const handler = (e: Event) => setItems((prev) => [...prev, (e as CustomEvent<ToastItem>).detail]);
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
  const visible = items.slice(-MAX_VISIBLE);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6">
      {visible.map((it) => <ToastRow key={it.id} item={it} onDismiss={dismiss} />)}
    </div>
  );
}
