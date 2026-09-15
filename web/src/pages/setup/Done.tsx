import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';
import { Flash } from '../../components/Flash';
import { StepFooter } from './StepFooter';

export function Done({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  // The server names the step still missing; that is the one place the owner needs to go.
  const missing = err instanceof ApiError && err.status === 409 ? (err.details as { step?: string } | undefined)?.step ?? null : null;
  return (
    <div className="space-y-4">
      {missing ? (
        <Flash tone="danger" role="alert">
          <p className="font-semibold text-danger">{copy.setup.done.notYet}</p>
          <p>{err?.message}</p>
        </Flash>
      ) : (
        <Flash tone="success"><p>{copy.setup.done.body}</p></Flash>
      )}
      {!missing && <ErrorCard error={err} />}
      <StepFooter>
        {missing && <Button type="button" variant="secondary" onClick={() => nav(`/setup/${missing}`)}>{copy.setup.done.goFix}</Button>}
        <Button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { await api.post('/api/setup/complete'); onDone(); } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
        }}>{copy.setup.done.finish}</Button>
      </StepFooter>
    </div>
  );
}
