import { useEffect, useRef, useState } from 'react';
import type { Confirm } from '../api/types';
import { Button } from './Button';
import { TextField } from './TextField';
import { ErrorCard, type Explained } from './ErrorCard';
import { copy } from '../copy/en';

/**
 * The confirmation in front of anything that moves money or changes who can. It asks for the PIN
 * when one is set (brief 2, item 3) — six digits, a tap on a phone — and always keeps the password
 * one tap away, so a forgotten PIN is never a locked door. What it hands back is the body the server
 * expects: `{ pin }` or `{ password }`, never both and never logged.
 */
export function PasswordConfirmDialog({ open, title, onConfirm, onCancel, busy, error, challenge, danger, pin }: {
  open: boolean; title: string; onConfirm: (confirm: Confirm) => void; onCancel: () => void;
  busy?: boolean; error?: Error | Explained | null; challenge?: { label: string; expected: string };
  danger?: boolean; /** A PIN is set for this person: ask for it first. */
  pin?: boolean;
}) {
  const [secret, setSecret] = useState('');
  const [asPin, setAsPin] = useState(pin === true);
  const [typed, setTyped] = useState('');
  const challengeOk = !challenge || typed.trim() === challenge.expected;
  const secretOk = asPin ? secret.length === 6 : secret.length > 0;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setSecret(''); setTyped(''); setAsPin(pin === true);
  }, [open, pin]);
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
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4">
      <form className="w-full max-w-md rounded-md border border-line bg-surface" onSubmit={(e) => { e.preventDefault(); onConfirm(asPin ? { pin: secret } : { password: secret }); }}>
        <h2 className="border-b border-line px-4 py-3 text-base font-semibold">{title}</h2>
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted">{asPin ? copy.confirm.whyPin : copy.confirm.why}</p>
          {challenge && <TextField label={challenge.label} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
          <TextField label={asPin ? copy.confirm.yourPin : copy.confirm.yourPassword} type="password" value={secret}
            onChange={(e) => setSecret(e.target.value)} autoFocus autoComplete={asPin ? 'off' : 'current-password'}
            inputMode={asPin ? 'numeric' : undefined} maxLength={asPin ? 6 : undefined} />
          {pin && (
            <button type="button" className="cursor-pointer text-sm text-brand underline" onClick={() => { setAsPin(!asPin); setSecret(''); }}>
              {asPin ? copy.confirm.usePassword : copy.confirm.usePin}
            </button>
          )}
          <ErrorCard error={error ?? null} />
        </div>
        <div className="flex justify-end gap-2 border-t border-line bg-page px-4 py-3">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>{copy.confirm.cancel}</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={busy || !secretOk || !challengeOk}>{copy.confirm.confirm}</Button>
        </div>
      </form>
    </div>
  );
}
