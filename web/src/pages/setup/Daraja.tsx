import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { Questionnaire } from '../../components/Questionnaire';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { Flash } from '../../components/Flash';
import { StepFooter } from './StepFooter';

export function Daraja({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const { saved } = useSession();
  // The secret is never sent back to the browser, so a step already passed shows that it was
  // accepted and offers Replace instead of two blank fields.
  const [replacing, setReplacing] = useState(false);
  const [f, setF] = useState({ consumerKey: '', consumerSecret: '' });
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { const r = await api.post<{ ok: boolean; message: string }>('/api/setup/daraja', f); if (r.ok) { toast.success(r.message); onDone(); } else setErr(new Error(r.message)); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
  };
  if (saved?.darajaVerified && !replacing) {
    return (
      <div className="space-y-4">
        <Flash tone="success" role="status">{copy.setup.daraja.accepted}</Flash>
        <Button type="button" variant="secondary" onClick={() => setReplacing(true)}>{copy.settings.replace}</Button>
        <StepFooter onBack={onBack}><Button type="button" onClick={onDone}>{copy.setup.next}</Button></StepFooter>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Questionnaire doneLabel={copy.setup.next} busy={busy} onDone={() => void submit()} onCancel={replacing ? () => setReplacing(false) : onBack} steps={[
        { key: 'key', question: copy.setup.daraja.key, valid: f.consumerKey.length > 0, render: () => <TextField label={copy.setup.daraja.key} labelHidden value={f.consumerKey} onChange={(e) => setF({ ...f, consumerKey: e.target.value })} autoFocus autoComplete="off" /> },
        { key: 'secret', question: copy.setup.daraja.secret, valid: f.consumerSecret.length > 0, render: () => <TextField label={copy.setup.daraja.secret} labelHidden type="password" value={f.consumerSecret} onChange={(e) => setF({ ...f, consumerSecret: e.target.value })} autoComplete="off" autoFocus /> },
      ]} />
      <ErrorCard error={err} />
    </div>
  );
}
