import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { Questionnaire } from '../../components/Questionnaire';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';

export function Daraja({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ consumerKey: '', consumerSecret: '' });
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { const r = await api.post<{ ok: boolean; message: string }>('/api/setup/daraja', f); if (r.ok) { toast.success(r.message); onDone(); } else setErr(new Error(r.message)); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Questionnaire doneLabel={copy.setup.next} busy={busy} onDone={() => void submit()} onCancel={onBack} steps={[
        { key: 'key', question: copy.setup.daraja.key, valid: f.consumerKey.length > 0, render: () => <TextField label={copy.setup.daraja.key} labelHidden value={f.consumerKey} onChange={(e) => setF({ ...f, consumerKey: e.target.value })} autoFocus autoComplete="off" /> },
        { key: 'secret', question: copy.setup.daraja.secret, valid: f.consumerSecret.length > 0, render: () => <TextField label={copy.setup.daraja.secret} labelHidden type="password" value={f.consumerSecret} onChange={(e) => setF({ ...f, consumerSecret: e.target.value })} autoComplete="off" autoFocus /> },
      ]} />
      <ErrorCard error={err} />
    </div>
  );
}
