import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { ErrorCard } from '../components/ErrorCard';
import { Questionnaire } from '../components/Questionnaire';
import { copy } from '../copy/en';

export function ChangePassword({ voluntary = false, onDone }: { voluntary?: boolean; onDone?: () => void } = {}) {
  const session = useSession();
  const [form, setForm] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const valid = !!form.current && form.next.length >= 12 && form.next === form.again && form.next !== form.current;
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    try {
      await api.post('/api/auth/change-password', { currentPassword: form.current, newPassword: form.next });
      setForm({ current: '', next: '', again: '' });
      await session.refresh();
      onDone?.();
    } catch (e2) { setError(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setBusy(true); setError(null);
    try { await api.post('/api/auth/logout'); await session.refresh(); }
    catch (e) { setError(e instanceof ApiError ? e : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };
  return (
    <div className="mx-auto mt-8 max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">{copy.changePassword.title}</h1>
      <Questionnaire doneLabel={copy.changePassword.save} busy={busy} onDone={() => void save()} onCancel={voluntary && onDone ? onDone : undefined}
        intro={voluntary ? copy.changePassword.voluntaryIntro : copy.changePassword.intro}
        footerStart={!voluntary ? <Button type="button" variant="ghost" disabled={busy} onClick={() => void logout()}>{copy.nav.logout}</Button> : undefined}
        steps={[
          { key: 'current', question: copy.changePassword.current, valid: !!form.current, render: () => <TextField label={copy.changePassword.current} labelHidden type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} autoComplete="current-password" autoFocus /> },
          { key: 'next', question: copy.changePassword.next, valid: form.next.length >= 12 && form.next !== form.current, render: () => <TextField label={copy.changePassword.next} labelHidden type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} autoComplete="new-password" autoFocus /> },
          { key: 'again', question: copy.changePassword.again, valid: form.again === form.next, render: () => <TextField label={copy.changePassword.again} labelHidden type="password" value={form.again} onChange={(e) => setForm({ ...form, again: e.target.value })} autoComplete="new-password" autoFocus error={form.again && form.again !== form.next ? copy.changePassword.mismatch : undefined} /> },
        ]} />
      <ErrorCard error={error} />
    </div>
  );
}
