import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { TextField } from '../components/TextField';
import { ErrorCard } from '../components/ErrorCard';
import { copy } from '../copy/en';

export function Login() {
  const { refresh } = useSession();
  const [u, setU] = useState(''); const [p, setP] = useState('');
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="min-h-screen bg-page px-4 pt-16 md:pt-24">
      <div className="mx-auto max-w-sm space-y-6">
        <img src="/logo-long.png" alt={copy.appName} className="mx-auto h-14 w-auto" />
        <Card title={copy.login.title}>
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
        </Card>
      </div>
    </div>
  );
}
