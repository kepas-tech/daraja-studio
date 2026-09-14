import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';
import { Flash } from '../../components/Flash';
import { StepFooter } from './StepFooter';

export function Done({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <Flash tone="success"><p>{copy.setup.done.body}</p></Flash>
      <ErrorCard error={err} />
      <StepFooter><Button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { await api.post('/api/setup/complete'); onDone(); } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
      }}>{copy.setup.done.finish}</Button></StepFooter>
    </div>
  );
}
