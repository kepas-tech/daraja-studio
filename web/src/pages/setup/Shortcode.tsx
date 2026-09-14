import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';

export function Shortcode({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [shortcode, setShortcode] = useState('');
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const valid = /^\d{5,7}$/.test(shortcode);
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try {
        const r = await api.post<{ verifiedName: string | null; verifyError: string | null }>('/api/setup/shortcode', { shortcode });
        const text = r.verifiedName ? copy.setup.shortcode.verified(r.verifiedName) : copy.setup.shortcode.notVerified;
        setMsg(text);
        toast.success(text);
        // Stay busy until we navigate away — reset only happens on the error path below.
        timerRef.current = setTimeout(onDone, 800);
      } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); setBusy(false); }
    }}>
      <TextField label={copy.setup.shortcode.field} inputMode="numeric" value={shortcode} onChange={(e) => setShortcode(e.target.value)} autoFocus />
      {msg && <p className="text-emerald-800">{msg}</p>}
      <ErrorCard error={err} />
      <div className="flex gap-2"><Button type="button" variant="secondary" onClick={onBack} disabled={busy}>{copy.setup.back}</Button><Button type="submit" disabled={!valid || busy}>{copy.setup.next}</Button></div>
    </form>
  );
}
