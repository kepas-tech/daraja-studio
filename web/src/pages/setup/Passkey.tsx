import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { PhoneInput } from '../../components/PhoneInput';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';
import { normalizeKe } from '../../format';

/**
 * The step that proves a passkey, which nothing else can.
 *
 * No read-only Daraja call uses a passkey, so the only evidence it is right is Safaricom accepting
 * a push made with it. Safaricom refuses a wrong one at the acknowledgement — before any phone
 * rings — so this is safe: a failure costs nothing and reaches nobody, and a success can be
 * cancelled on the owner's own handset. It is the difference between saying "ready" because a box
 * is non-empty and saying it because Safaricom agreed.
 */
export function Passkey({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [passkey, setPasskey] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'proven' | 'refused' | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const c = copy.setup.passkey;

  const normalised = normalizeKe(phone);
  const ready = passkey.trim().length > 0 && !!normalised;

  const submit = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await api.post<{ proven: boolean }>('/api/setup/passkey', { passkey: passkey.trim(), phone: normalised });
      setResult(r.proven ? 'proven' : 'refused');
    } catch (e) {
      setErr(e instanceof ApiError ? e : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };

  if (result === 'proven') {
    return (
      <div className="space-y-4">
        <div role="status" className="rounded-lg border border-[#186738] p-4">
          <p className="text-base font-medium text-[#186738]">{c.proven}</p>
          <p className="text-base text-black dark:text-white">{c.provenNote}</p>
        </div>
        <Button type="button" onClick={onDone}>{copy.setup.next}</Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
      <p className="text-base text-black dark:text-white">{c.where}</p>

      {result === 'refused' && (
        // Safaricom refused it, so nothing was sent and nothing was charged. Said plainly, because
        // this is the exact moment a wrong passkey used to slip through and be called ready.
        <div role="alert" className="rounded-lg border border-[#da222a] p-4">
          <p className="text-base font-medium text-[#da222a]">{c.failedTitle}</p>
          <p className="text-base text-black dark:text-white">{c.failedBody}</p>
        </div>
      )}

      <TextField label={c.field} type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} autoComplete="off" autoFocus />
      <PhoneInput label={c.phone} value={phone} onChange={setPhone} />
      <p className="text-sm text-black dark:text-[#cccccc]">{c.phoneHelp}</p>

      <div className="rounded-lg border border-[#cccccc] p-4">
        <p className="text-base font-medium">{c.testTitle}</p>
        <p className="text-base text-black dark:text-white">{c.testBody}</p>
      </div>

      <ErrorCard error={err} />
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onBack}>{copy.setup.back}</Button>
        <Button type="submit" disabled={!ready || busy}>{busy ? c.testing : result === 'refused' ? c.retry : c.test}</Button>
      </div>
    </form>
  );
}
