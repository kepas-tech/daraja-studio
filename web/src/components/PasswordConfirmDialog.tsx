import { useEffect, useRef, useState } from 'react';
import type { Confirm } from '../api/types';
import { Button } from './Button';
import { PinEntry } from './PinEntry';
import { TextField } from './TextField';
import { ErrorCard, type Explained } from './ErrorCard';
import { copy } from '../copy/en';
import logo from '../assets/logo-long.png';

/**
 * The confirmation in front of anything that moves money or changes who can. When a PIN is set
 * (brief 2, item 3) it is kepas-pay's money sheet (brief 2, item 5): the same dots and keypad as the
 * lock screen, the sixth digit submits by itself, and the bottom-left key cancels instead of
 * offering a fingerprint. The password stays one tap away underneath, so a forgotten PIN is never a
 * locked door.
 *
 * What it hands back is the body the server expects: `{ pin }` or `{ password }`, never both and
 * never logged.
 *
 * Item 6: the keypad carries the same long logo as the lock screen, at 24 px so the dots and all
 * twelve keys still fit a phone (measured at 375x667 and 360x640). The overlay scrolls if a shorter
 * screen cannot show the whole sheet.
 */
export function PasswordConfirmDialog({ open, title, onConfirm, onCancel, busy, error, challenge, danger, pin }: {
  open: boolean; title: string; onConfirm: (confirm: Confirm) => void; onCancel: () => void;
  busy?: boolean; error?: Error | Explained | null; challenge?: { label: string; expected: string };
  danger?: boolean; /** A PIN is set for this person: draw the keypad first. */
  pin?: boolean;
}) {
  const [secret, setSecret] = useState('');
  const [asPin, setAsPin] = useState(pin === true);
  const [typed, setTyped] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const challengeOk = !challenge || typed.trim() === challenge.expected;
  const secretOk = asPin ? secret.length === 6 : secret.length > 0;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setSecret(''); setTyped(''); setAsPin(pin === true); setResetKey((k) => k + 1);
  }, [open, pin]);
  // A refusal clears the dots: the same six digits must be typed again, exactly as on the lock screen.
  useEffect(() => { if (error) setResetKey((k) => k + 1); }, [error]);
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
  const keypad = asPin;
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex overflow-y-auto bg-ink/50 p-4">
      <form className="m-auto w-full max-w-md rounded-md border border-line bg-surface" onSubmit={(e) => { e.preventDefault(); onConfirm(asPin ? { pin: secret } : { password: secret }); }}>
        <h2 className="border-b border-line px-4 py-3 text-base font-semibold">{title}</h2>
        <div className={keypad ? 'space-y-3 p-3' : 'space-y-4 p-4'}>
          {keypad ? (
            <>
              <img src={logo} alt={copy.appName} className="mx-auto h-6 w-auto" />
              <p className="text-center text-[13px] text-muted">{copy.confirm.pinSub}</p>
              <PinEntry onComplete={(value) => onConfirm({ pin: value })} message={busy ? copy.lock.checking : ''} busy={busy}
                resetKey={resetKey} alt={{ kind: 'cancel', label: copy.confirm.cancel, onClick: onCancel }} />
              <div className="text-center">
                <button type="button" className="cursor-pointer text-sm text-brand-dark underline" onClick={() => { setAsPin(false); setSecret(''); }}>
                  {copy.confirm.usePassword}
                </button>
              </div>
              <ErrorCard error={error ?? null} />
            </>
          ) : (
            <>
              <p className="text-sm text-muted">{copy.confirm.why}</p>
              {challenge && <TextField label={challenge.label} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
              <TextField label={copy.confirm.yourPassword} type="password" value={secret}
                onChange={(e) => setSecret(e.target.value)} autoFocus autoComplete="current-password" />
              {pin && (
                <button type="button" className="cursor-pointer text-sm text-brand-dark underline" onClick={() => { setAsPin(true); setSecret(''); }}>
                  {copy.confirm.usePin}
                </button>
              )}
              <ErrorCard error={error ?? null} />
            </>
          )}
        </div>
        {!keypad && (
          <div className="flex justify-end gap-2 border-t border-line bg-page px-4 py-3">
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>{copy.confirm.cancel}</Button>
            <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={busy || !secretOk || !challengeOk}>{copy.confirm.confirm}</Button>
          </div>
        )}
      </form>
    </div>
  );
}
