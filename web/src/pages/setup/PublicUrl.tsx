import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { Flash } from '../../components/Flash';
import { StepFooter } from './StepFooter';
import { useSession } from '../../app/session';

export function PublicUrl({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  // The address Safaricom needs is this studio's own, and the browser reached this page through
  // exactly that address, so it is shown read-only; Change exists for a studio served under more
  // than one domain. A plain-http origin is only accepted for local development.
  const origin = window.location.origin;
  const detected = origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin) ? origin : null;
  const { saved } = useSession();
  const [url, setUrl] = useState(saved?.publicUrl ?? detected ?? ''); const [editing, setEditing] = useState(detected === null && !saved?.publicUrl);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(saved?.publicVerified ? { ok: true, detail: copy.setup.publicUrl.ok } : null);
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
      {editing ? (
        <TextField label={copy.setup.publicUrl.field} hint={copy.setup.publicUrl.hint} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={copy.setup.publicUrl.placeholder} autoFocus />
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3">
          <div>
            <div className="text-sm text-muted">{copy.setup.publicUrl.detected}</div>
            <div className="font-medium break-all">{url}</div>
          </div>
          <Button type="button" variant="ghost" onClick={() => setEditing(true)}>{copy.setup.publicUrl.change}</Button>
        </div>
      )}
      <Button type="button" variant="secondary" onClick={test} disabled={busy || !url}>{copy.setup.publicUrl.test}</Button>
      {result && <Flash tone={result.ok ? 'success' : 'danger'} role="status">{result.detail}{!result.ok && <> {copy.setup.publicUrl.notThis}</>}</Flash>}
      <ErrorCard error={err} />
      <StepFooter onBack={onBack}><Button type="button" onClick={onDone} disabled={!result?.ok}>{copy.setup.next}</Button></StepFooter>
    </div>
  );
}
