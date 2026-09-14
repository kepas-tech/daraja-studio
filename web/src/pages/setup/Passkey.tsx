import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { PhoneInput } from '../../components/PhoneInput';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';
import { Flash } from '../../components/Flash';
import { StepFooter } from './StepFooter';
import { Questionnaire } from '../../components/Questionnaire';
import { normalizeKe } from '../../format';
import { useSession } from '../../app/session';

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
  const { passkeyProven } = useSession();
  const [result, setResult] = useState<'proven' | 'refused' | null>(passkeyProven ? 'proven' : null);
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
        <Flash tone="success" role="status">
          <p className="font-semibold text-brand-dark">{c.proven}</p>
          <p>{c.provenNote}</p>
        </Flash>
        <StepFooter><Button type="button" onClick={onDone}>{copy.setup.next}</Button></StepFooter>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {result === 'refused' && (
        // Safaricom refused it, so nothing was sent and nothing was charged. Said plainly, because
        // this is the exact moment a wrong passkey used to slip through and be called ready.
        <Flash tone="danger" role="alert">
          <p className="font-semibold text-danger">{c.failedTitle}</p>
          <p>{c.failedBody}</p>
        </Flash>
      )}
      <Flash tone="neutral">
        <p className="font-semibold">{c.testTitle}</p>
        <p>{c.testBody}</p>
      </Flash>
      <Questionnaire doneLabel={busy ? c.testing : result === 'refused' ? c.retry : c.test} busy={busy} onDone={() => { if (ready) void submit(); }} onCancel={onBack} steps={[
        { key: 'passkey', question: c.field, valid: passkey.trim().length > 0, render: () => <TextField label={c.field} labelHidden type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} autoComplete="off" autoFocus /> },
        { key: 'phone', question: c.phone, hint: c.phoneHelp, valid: !!normalised, render: () => <PhoneInput label={c.phone} labelHidden value={phone} onChange={setPhone} autoFocus /> },
      ]} />
      <ErrorCard error={err} />
    </div>
  );
}
