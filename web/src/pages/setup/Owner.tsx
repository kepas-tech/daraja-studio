import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';

export function Owner({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ displayName: '', username: '', password: '' });
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const valid = f.displayName && /^[a-z0-9_.-]{3,32}$/i.test(f.username) && f.password.length >= 12;
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { const r = await api.post<{ csrf: string }>('/api/setup/owner', f); api.setCsrf(r.csrf); onDone(); }
      catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
    }}>
      <TextField label={copy.setup.owner.displayName} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} autoFocus />
      <TextField label={copy.setup.owner.username} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" />
      <TextField label={copy.setup.owner.password} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
      <ErrorCard error={err} />
      <Button type="submit" disabled={!valid || busy}>{copy.setup.owner.button}</Button>
    </form>
  );
}
