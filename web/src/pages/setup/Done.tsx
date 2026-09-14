import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';

export function Done({ onDone }: { onDone: () => void }) {
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{copy.setup.done.title}</h2>
      <p>{copy.setup.done.body}</p>
      <ErrorCard error={err} />
      <Button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { await api.post('/api/setup/complete'); onDone(); } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
      }}>{copy.setup.done.finish}</Button>
    </div>
  );
}
