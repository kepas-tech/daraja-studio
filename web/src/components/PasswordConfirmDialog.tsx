import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { TextField } from './TextField';
import { ErrorCard, type Explained } from './ErrorCard';
import { copy } from '../copy/en';

export function PasswordConfirmDialog({ open, title, onConfirm, onCancel, busy, error }: { open: boolean; title: string; onConfirm: (password: string) => void; onCancel: () => void; busy?: boolean; error?: Error | Explained | null }) {
  const [pw, setPw] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) setPw(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (!busy) onCancel(); return; }
      if (e.key === 'Tab') {
        const el = dialogRef.current;
        if (!el) return;
        const focusable = el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel, busy]);
  if (!open) return null;
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form className="w-full max-w-md space-y-4 rounded-xl bg-white p-6 dark:bg-gray-900" onSubmit={(e) => { e.preventDefault(); onConfirm(pw); }}>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-gray-600">{copy.confirm.why}</p>
        <TextField label={copy.confirm.yourPassword} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" />
        <ErrorCard error={error ?? null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>{copy.confirm.cancel}</Button>
          <Button type="submit" disabled={busy || !pw}>{copy.confirm.confirm}</Button>
        </div>
      </form>
    </div>
  );
}
