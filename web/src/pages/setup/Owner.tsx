import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { Questionnaire } from '../../components/Questionnaire';
import { copy } from '../../copy/en';
import { Button } from '../../components/Button';
import { Flash } from '../../components/Flash';
import { StepFooter } from './StepFooter';

export function Owner({ onDone, created }: { onDone: () => void; created?: string | null }) {
  const [f, setF] = useState({ displayName: '', username: '', password: '' });
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const valid = !!f.displayName && /^[a-z0-9_.-]{3,32}$/i.test(f.username) && f.password.length >= 12;
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setErr(null);
    try { const r = await api.post<{ csrf: string }>('/api/setup/owner', f); api.setCsrf(r.csrf); onDone(); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
  };
  // Reached by Back from the next step: the account exists, so show it rather than a form that would be refused.
  if (created) {
    return (
      <div className="space-y-4">
        <Flash tone="success">{copy.setup.owner.created(created)}</Flash>
        <StepFooter><Button type="button" onClick={onDone}>{copy.setup.next}</Button></StepFooter>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <Questionnaire doneLabel={copy.setup.owner.button} busy={busy} onDone={() => void submit()} steps={[
        { key: 'name', question: copy.setup.owner.displayName, valid: f.displayName.trim().length > 0, render: () => <TextField label={copy.setup.owner.displayName} labelHidden value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} autoFocus /> },
        { key: 'username', question: copy.setup.owner.username, valid: /^[a-z0-9_.-]{3,32}$/i.test(f.username), render: () => <TextField label={copy.setup.owner.username} labelHidden value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" autoFocus /> },
        { key: 'password', question: copy.setup.owner.password, valid: f.password.length >= 12, render: () => <TextField label={copy.setup.owner.password} labelHidden type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" autoFocus /> },
      ]} />
      <ErrorCard error={err} />
    </div>
  );
}
