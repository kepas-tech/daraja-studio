import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { StepFooter } from './StepFooter';

export function Org({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', nominatedNumber: '', notificationPhone: '' });
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const valid = f.name && /^254\d{9}$/.test(f.nominatedNumber) && /^254\d{9}$/.test(f.notificationPhone);
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try {
        await api.post('/api/setup/org', f);
        toast.success(copy.settings.saved);
        onDone();
      } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
    }}>
      <TextField label={copy.setup.org.name} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
      <TextField label={copy.setup.org.nominated} inputMode="numeric" value={f.nominatedNumber} onChange={(e) => setF({ ...f, nominatedNumber: e.target.value })} />
      <TextField label={copy.setup.org.notify} inputMode="numeric" value={f.notificationPhone} onChange={(e) => setF({ ...f, notificationPhone: e.target.value })} />
      <ErrorCard error={err} />
      <StepFooter onBack={onBack}><Button type="submit" disabled={!valid || busy}>{copy.setup.next}</Button></StepFooter>
    </form>
  );
}
