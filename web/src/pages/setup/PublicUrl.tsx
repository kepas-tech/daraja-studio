import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { Flash } from '../../components/Flash';
import { StepFooter } from './StepFooter';

export function PublicUrl({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  // The address Safaricom needs is this studio's own, so the browser's address bar is the right
  // default; a plain-http dev origin is offered too since the server accepts localhost.
  const origin = window.location.origin;
  const [url, setUrl] = useState(origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin) ? origin : ''); const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const test = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      await api.post('/api/setup/public-url', { url });
      const r = await api.post<{ ok: boolean; detail: string }>('/api/setup/public-url/test');
      setResult(r);
      if (r.ok) toast.success(r.detail); else toast.error(r.detail);
    }
    catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <TextField label={copy.setup.publicUrl.field} hint={copy.setup.publicUrl.hint} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={copy.setup.publicUrl.placeholder} autoFocus />
      <Button type="button" variant="secondary" onClick={test} disabled={busy || !url}>{copy.setup.publicUrl.test}</Button>
      {result && <Flash tone={result.ok ? 'success' : 'danger'} role="status">{result.detail}{!result.ok && <> {copy.setup.publicUrl.notThis}</>}</Flash>}
      <ErrorCard error={err} />
      <StepFooter onBack={onBack}><Button type="button" onClick={onDone} disabled={!result?.ok}>{copy.setup.next}</Button></StepFooter>
    </div>
  );
}
