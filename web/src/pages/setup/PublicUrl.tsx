import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';

export function PublicUrl({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState(''); const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
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
      <TextField label={copy.setup.publicUrl.field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={copy.setup.publicUrl.placeholder} autoFocus />
      <Button type="button" variant="secondary" onClick={test} disabled={busy || !url}>{copy.setup.publicUrl.test}</Button>
      {result && <p role="status" className={result.ok ? 'text-emerald-800' : 'text-red-800'}>{result.detail}</p>}
      <ErrorCard error={err} />
      <div className="flex gap-2"><Button type="button" variant="secondary" onClick={onBack}>{copy.setup.back}</Button><Button type="button" onClick={onDone} disabled={!result?.ok}>{copy.setup.next}</Button></div>
    </div>
  );
}
