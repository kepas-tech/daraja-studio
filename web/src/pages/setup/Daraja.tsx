import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { StepFooter } from './StepFooter';

export function Daraja({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ consumerKey: '', consumerSecret: '' });
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { const r = await api.post<{ ok: boolean; message: string }>('/api/setup/daraja', f); if (r.ok) { toast.success(r.message); onDone(); } else setErr(new Error(r.message)); }
      catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
    }}>
      <TextField label={copy.setup.daraja.key} value={f.consumerKey} onChange={(e) => setF({ ...f, consumerKey: e.target.value })} autoFocus autoComplete="off" />
      <TextField label={copy.setup.daraja.secret} type="password" value={f.consumerSecret} onChange={(e) => setF({ ...f, consumerSecret: e.target.value })} autoComplete="off" />
      <ErrorCard error={err} />
      <StepFooter onBack={onBack}><Button type="submit" disabled={busy || !f.consumerKey || !f.consumerSecret}>{copy.setup.next}</Button></StepFooter>
    </form>
  );
}
