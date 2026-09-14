import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { StepFooter } from './StepFooter';
import { Flash } from '../../components/Flash';
import { StatusPill } from '../../components/StatusPill';

type Env = 'sandbox' | 'production';
const ENVS: Env[] = ['sandbox', 'production'];

export function Environment({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [env, setEnv] = useState<Env>('sandbox');
  const [confirm, setConfirm] = useState(''); const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try {
        await api.post('/api/setup/environment', { environment: env, confirmShortcode: confirm || undefined });
        toast.success(copy.settings.saved);
        onDone();
      } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
    }}>
      {/* A segmented control: two joined choices, the chosen one filled. The radio inputs stay in the
          document (visually hidden) so the choice is a real form control for keyboards and readers. */}
      <div className="flex">
        {ENVS.map((k, i) => (
          <label key={k} className={`flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 border px-4 text-center text-base font-semibold focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-brand ${i === 0 ? 'rounded-l-md' : '-ml-px rounded-r-md'} ${env === k ? 'z-10 border-brand bg-brand text-surface' : 'border-line bg-page text-ink hover:bg-line/60'}`}>
            <input type="radio" name="environment" className="sr-only" checked={env === k} onChange={() => setEnv(k)} />
            {copy.setup.env[k]}{k === 'sandbox' && env !== 'sandbox' && <StatusPill kind="ok">{copy.setup.env.recommended}</StatusPill>}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 text-sm text-muted"><p>{copy.setup.env.sandboxHint}</p><p>{copy.setup.env.productionHint}</p></div>
      <Flash tone="neutral">{copy.setup.env.advice}</Flash>
      {env === 'production' && <TextField label={copy.setup.env.confirm} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      <ErrorCard error={err} />
      <StepFooter><Button type="submit" disabled={busy}>{copy.setup.next}</Button></StepFooter>
    </form>
  );
}
