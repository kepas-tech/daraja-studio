import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from './session';
import { PinEntry } from '../components/PinEntry';
import { Button } from '../components/Button';
import { ErrorCard, type Explained } from '../components/ErrorCard';
import { TextField } from '../components/TextField';
import { BUZZ, buzz } from './haptics';
import { platformAvailable } from './webauthn';
import { copy } from '../copy/en';
import logo from '../assets/logo-long.png';

/** How long the PIN is locked for when the server does not say: the same 15 minutes the lockout uses. */
const LOCK_MINUTES = 15;

/** "Locked. Try again in N min." for a locked PIN, or null when the refusal is something else. */
function lockedFor(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code !== 'pin_locked' && e.code !== 'locked' && e.status !== 429) return null;
  const details = e.details as { retryAfterSec?: unknown } | undefined;
  const seconds = typeof details?.retryAfterSec === 'number' ? details.retryAfterSec : LOCK_MINUTES * 60;
  return copy.lock.lockedFor(Math.max(1, Math.ceil(seconds / 60)));
}

/**
 * Brief 2, item 5: the lock screen as kepas-pay draws it. A brand block, six dots, one line that
 * says what is happening, the keypad, and two ways out (the password that always works, and signing
 * out). The fingerprint is the bottom-left key when this person has one enrolled; the prompt is
 * tried once on load, because iOS usually needs the tap.
 *
 * Item 6: the brand block is the full long logo now — the logo itself carries the studio name, so
 * the letter square and the separate name line are gone and the Locked line sits right under it.
 */
export function LockScreen() {
  const { person, pinBio, openSession, openWithFingerprint, refresh } = useSession();
  const [mode, setMode] = useState<'pin' | 'password'>('pin');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Error | Explained | null>(null);
  /** The fingerprint key only exists when this device can actually offer one. */
  const [bioReady, setBioReady] = useState(false);
  const asked = useRef(false);

  const tryFingerprint = useCallback(async () => {
    setBusy(true); setMessage(copy.lock.waiting);
    const ok = await openWithFingerprint();
    // On success the session opens and this whole screen goes away; nothing to set.
    if (!ok) { setBusy(false); setMessage(copy.lock.enterPin); setResetKey((k) => k + 1); }
  }, [openWithFingerprint]);

  // Once per page load: offer the fingerprint without being asked. A refusal is silent, and the
  // keypad below is already there.
  useEffect(() => {
    if (!pinBio || asked.current) return;
    asked.current = true;
    void platformAvailable().then((ok) => {
      setBioReady(ok);
      if (ok) void tryFingerprint();
    });
  }, [pinBio, tryFingerprint]);

  const submitPin = useCallback(async (pin: string) => {
    setBusy(true); setMessage(copy.lock.checking);
    try {
      await openSession({ pin });
      buzz([...BUZZ.ok]);
    } catch (e) {
      buzz(BUZZ.no);
      setBusy(false);
      setResetKey((k) => k + 1);
      setMessage(lockedFor(e) ?? (e instanceof ApiError && e.code === 'pin_wrong' ? copy.lock.wrongPin : copy.lock.network));
    }
  }, [openSession]);

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await openSession({ password }); buzz([...BUZZ.ok]); }
    catch (err) { buzz(BUZZ.no); setError(err instanceof ApiError ? err : new Error(copy.error.generic)); setPassword(''); }
    finally { setBusy(false); }
  };

  const signOut = async () => { await api.post('/api/auth/logout'); await refresh(); };

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-5 py-6 select-none [-webkit-tap-highlight-color:transparent]">
      <div className="w-full max-w-[320px] text-center" data-testid="lock-screen">
        <div className="mb-[22px]">
          <img src={logo} alt={copy.appName} className="mx-auto mb-3 h-14 w-auto" />
          <p className="mt-0.5 text-[13px] text-muted">{mode === 'pin' ? copy.lock.sub : copy.lock.subPassword}</p>
        </div>

        {mode === 'pin' ? (
          <PinEntry onComplete={(pin) => void submitPin(pin)} message={message} busy={busy} resetKey={resetKey}
            alt={bioReady ? { kind: 'bio', label: copy.lock.fingerprint, onClick: () => void tryFingerprint() } : null} />
        ) : (
          <form onSubmit={(e) => void submitPassword(e)} className="space-y-3 text-left">
            <TextField label={copy.confirm.yourPassword} type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
            <ErrorCard error={error} />
            <Button type="submit" className="w-full" disabled={busy || password.length === 0}>{copy.lock.continueLabel}</Button>
          </form>
        )}

        <button type="button" className="mt-4 cursor-pointer text-sm text-brand-dark underline" onClick={() => { setMode(mode === 'pin' ? 'password' : 'pin'); setError(null); setMessage(''); setResetKey((k) => k + 1); }}>
          {mode === 'pin' ? copy.confirm.usePassword : copy.confirm.usePin}
        </button>
        <div className="mt-[22px]">
          <Button type="button" variant="ghost" onClick={() => void signOut()}>{copy.lock.signOut}</Button>
        </div>
        {person && <p className="mt-2 text-[13px] text-muted">{copy.lock.signedInAs(person.display_name)}</p>}
      </div>
    </div>
  );
}
