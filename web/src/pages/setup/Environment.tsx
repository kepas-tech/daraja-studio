import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';

export function Environment({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
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
      <label className="flex items-start gap-3">
        <input type="radio" name="environment" className="mt-1" checked={env === 'sandbox'} onChange={() => setEnv('sandbox')} />
        <span><span className="block">{copy.setup.env.sandbox}</span><span className="block text-sm text-gray-500">{copy.setup.env.sandboxHint}</span></span>
      </label>
      <label className="flex items-start gap-3">
        <input type="radio" name="environment" className="mt-1" checked={env === 'production'} onChange={() => setEnv('production')} />
        <span><span className="block">{copy.setup.env.production}</span><span className="block text-sm text-gray-500">{copy.setup.env.productionHint}</span></span>
      </label>
      {env === 'production' && <TextField label={copy.setup.env.confirm} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      <ErrorCard error={err} />
      <Button type="submit" disabled={busy}>{copy.setup.next}</Button>
    </form>
  );
}
