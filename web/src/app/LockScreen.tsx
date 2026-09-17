import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useSession } from './session';
import { Button } from '../components/Button';
import { ErrorCard, type Explained } from '../components/ErrorCard';
import { TextField } from '../components/TextField';
import { copy } from '../copy/en';

/**
 * Brief 2, item 3. Covers the whole window while the PIN is owed: the app behind it is not drawn, so
 * nothing on screen can be tapped, read or half-filled. The PIN is the quick way in and the password
 * the way back for a forgotten one — the same two the server accepts from the lock screen.
 */
export function LockScreen() {
  const { person, openSession } = useSession();
  const [asPin, setAsPin] = useState(true);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | Explained | null>(null);
  const choose = (pin: boolean) => { setAsPin(pin); setSecret(''); setError(null); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await openSession(asPin ? { pin: secret } : { password: secret }); }
    catch (err) { setError(err instanceof ApiError ? err : new Error(copy.error.generic)); setSecret(''); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-md border border-line bg-surface p-6 shadow-lg" aria-label={copy.lock.title}>
        <h1 className="text-xl font-semibold">{copy.lock.title}</h1>
        <p className="mt-2 text-sm text-muted">{asPin ? copy.lock.pinBody : copy.lock.passwordBody}</p>
        {person && <p className="mt-1 text-sm text-muted">{copy.lock.signedInAs(person.display_name)}</p>}
        <TextField className="mt-4" label={asPin ? copy.confirm.yourPin : copy.confirm.yourPassword} type="password" value={secret}
          onChange={(e) => setSecret(e.target.value)} autoFocus autoComplete="off"
          inputMode={asPin ? 'numeric' : undefined} maxLength={asPin ? 6 : undefined} />
        <div className="mt-2"><ErrorCard error={error} /></div>
        <div className="mt-4 flex flex-col items-stretch gap-2">
          <Button type="submit" disabled={busy || secret.length === 0 || (asPin && secret.length !== 6)}>{copy.lock.continueLabel}</Button>
          <Button type="button" variant="ghost" onClick={() => choose(!asPin)}>{asPin ? copy.confirm.usePassword : copy.confirm.usePin}</Button>
        </div>
      </form>
    </div>
  );
}
