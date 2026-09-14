import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { ErrorCard } from '../components/ErrorCard';
import { copy } from '../copy/en';

export function Login() {
  const { refresh } = useSession();
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto mt-24 max-w-sm space-y-4">
      <img src="/logo-long.png" alt={copy.appName} className="mx-auto h-8 w-auto" />
      <div className="space-y-4 rounded-xl bg-white p-6 shadow dark:bg-gray-900">
        <h1 className="text-xl font-semibold">{copy.login.title}</h1>
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr(null);
          try { const r = await api.post<{ csrf: string }>('/api/auth/login', { username: u, password: p }); api.setCsrf(r.csrf); await refresh(); }
          catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); }
          finally { setBusy(false); }
        }}>
          <TextField label={copy.login.username} value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoFocus />
          <TextField label={copy.login.password} type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" />
          <ErrorCard error={err} />
          <Button type="submit" disabled={busy || !u || !p} className="w-full">{copy.login.button}</Button>
        </form>
      </div>
    </div>
  );
}
