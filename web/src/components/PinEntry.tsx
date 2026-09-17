import { useCallback, useEffect, useState } from 'react';
import { BackspaceIcon, CloseIcon, FingerprintIcon } from './LockIcons';
import { BUZZ, buzz } from '../app/haptics';
import { copy } from '../copy/en';

/** A PIN is six digits, exactly as the server's own rule says. */
export const PIN_LENGTH = 6;

/** The bottom-left key: the fingerprint on the lock screen, Cancel in the money dialog, nothing
 *  on a device with no credential (an empty cell, so 0 and backspace stay put). */
export type PinAlt = { kind: 'bio' | 'cancel'; label: string; onClick: () => void } | null;

/** Six dots, filled as digits are typed. Copied from kepas-pay: 13 px circles, 14 px apart. */
function Dots({ filled }: { filled: number }) {
  return (
    <div className="my-[22px] mb-2 flex justify-center gap-[14px]" aria-hidden="true" data-testid="pin-dots" data-filled={filled}>
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <span key={i} className={`size-[13px] rounded-full border-2 ${i < filled ? 'border-brand bg-brand' : 'border-line'}`} />
      ))}
    </div>
  );
}

/** The keypad itself: a 3-column grid of 280 px, keys are circles with a 44 px tap target. */
function Keys({ alt, busy, press, back }: { alt: PinAlt; busy: boolean; press: (d: string) => void; back: () => void }) {
  const key = 'flex aspect-square min-h-11 w-full cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-2xl font-semibold text-ink select-none [-webkit-tap-highlight-color:transparent] active:bg-page disabled:cursor-not-allowed disabled:opacity-50';
  const altKey = 'flex aspect-square min-h-11 w-full cursor-pointer items-center justify-center rounded-full border border-transparent bg-transparent text-muted select-none [-webkit-tap-highlight-color:transparent] active:bg-page disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="mx-auto grid max-w-[280px] grid-cols-3 gap-[14px]">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
        <button key={d} type="button" className={key} disabled={busy} onClick={() => press(d)}>{d}</button>
      ))}
      {alt ? (
        <button type="button" className={altKey} disabled={busy} aria-label={alt.label} onClick={alt.onClick}>
          {alt.kind === 'bio' ? <FingerprintIcon /> : <CloseIcon />}
        </button>
      ) : (
        <span />
      )}
      <button type="button" className={key} disabled={busy} onClick={() => press('0')}>0</button>
      <button type="button" className={altKey} disabled={busy} aria-label={copy.lock.backspace} onClick={back}>
        <BackspaceIcon />
      </button>
    </div>
  );
}

/**
 * Brief 2, item 5: the PIN pad, ported from kepas-pay's lock screen and money sheet. It owns the
 * six digits, fills a dot and buzzes on every press, and submits by itself on the sixth — there is
 * no confirm button. The line above it belongs to the caller: it says what is happening
 * ("Checking…", "Wrong PIN.", "Waiting for your fingerprint…").
 */
export function PinEntry({ onComplete, message, busy = false, alt = null, resetKey = 0 }: {
  onComplete: (pin: string) => void;
  message: string;
  busy?: boolean;
  alt?: PinAlt;
  /** Change this to clear the dots — after a refusal, the same six digits must be typed again. */
  resetKey?: number;
}) {
  const [digits, setDigits] = useState('');
  useEffect(() => { setDigits(''); }, [resetKey]);
  const press = useCallback((d: string) => {
    setDigits((v) => {
      if (busy || v.length >= PIN_LENGTH) return v;
      const next = v + d;
      buzz(BUZZ.key as number);
      // The sixth digit is the submit button, exactly as the keypad the owner asked for.
      if (next.length === PIN_LENGTH) onComplete(next);
      return next;
    });
  }, [busy, onComplete]);
  const back = useCallback(() => setDigits((v) => (busy ? v : v.slice(0, -1))), [busy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [press, back]);
  return (
    <div className="select-none">
      <Dots filled={digits.length} />
      {/* At least 20 px tall, so nothing jumps when the line changes. */}
      <p className="mb-4 min-h-5 text-[13px] text-muted" aria-live="polite" data-testid="pin-message">{message}</p>
      <Keys alt={alt} busy={busy} press={press} back={back} />
    </div>
  );
}
