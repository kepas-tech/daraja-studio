import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { ErrorCard } from '../components/ErrorCard';
import { copy } from '../copy/en';

export function ChangePassword() {
  const session = useSession();
  const [form, setForm] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const valid = !!form.current && form.next.length >= 12 && form.next === form.again && form.next !== form.current;
  return (
    <form className="mx-auto mt-16 max-w-md space-y-4 rounded-md border border-line bg-surface p-6" onSubmit={async (e) => {
      e.preventDefault();
      if (!valid || busy) return;
      setBusy(true); setError(null);
      try {
        await api.post('/api/auth/change-password', { currentPassword: form.current, newPassword: form.next });
        setForm({ current: '', next: '', again: '' });
        await session.refresh();
      } catch (e2) { setError(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); }
      finally { setBusy(false); }
    }}>
      <h1 className="text-xl font-semibold">{copy.changePassword.title}</h1>
      <p className="text-muted">{copy.changePassword.intro}</p>
      <TextField label={copy.changePassword.current} type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} autoComplete="current-password" autoFocus />
      <TextField label={copy.changePassword.next} type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} autoComplete="new-password" />
      <TextField label={copy.changePassword.again} type="password" value={form.again} onChange={(e) => setForm({ ...form, again: e.target.value })} autoComplete="new-password" />
      <ErrorCard error={error} />
      <Button type="submit" disabled={busy || !valid}>{copy.changePassword.save}</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await api.post('/api/auth/logout'); await session.refresh(); }
        catch (e) { setError(e instanceof ApiError ? e : new Error(copy.error.generic)); }
        finally { setBusy(false); }
      }}>{copy.nav.logout}</Button>
    </form>
  );
}
