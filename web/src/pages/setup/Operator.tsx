import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useEvents } from '../../api/events';
import type { OperatorView, SettingsView } from '../../api/types';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { StatusPill } from '../../components/StatusPill';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { StepFooter } from './StepFooter';
import { Questionnaire } from '../../components/Questionnaire';
import { Segmented } from '../../components/Segmented';

type Mode = 'modePassword' | 'modeCredential';

export function Operator({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('modeCredential');
  const [f, setF] = useState({ name: '', operatorPassword: '', certPem: '', credential: '' });
  const [ops, setOps] = useState<OperatorView[]>([]); const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get<SettingsView>('/api/settings').then((v) => setOps(v.environments[v.mode].operators)).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  // A refused operator is not kept, so its reason arrives on the event rather than on a row.
  useEvents(useCallback((e) => {
    if (e.type !== 'operator.updated') return;
    const p = e.payload as { removed?: boolean; lastError?: string } | null;
    if (p?.removed && p.lastError) setErr(new Error(p.lastError));
    void load();
  }, [load]));
  const tone = { pending: 'warn', verified: 'ok', failed: 'bad', disabled: 'muted' } as const;
  const textarea = 'min-h-32 w-full rounded-md border border-line bg-surface p-2 font-mono text-xs text-ink shadow-inner focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const body = mode === 'modePassword'
        ? { name: f.name, operatorPassword: f.operatorPassword, certPem: f.certPem }
        : { name: f.name, credential: f.credential };
      await api.post('/api/setup/operator', body);
      toast.success(copy.settings.saved);
      setF({ name: '', operatorPassword: '', certPem: '', credential: '' });
      await load();
    } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-6">
      <Questionnaire doneLabel={copy.setup.operator.add} busy={busy} onDone={() => void submit()} steps={[
        { key: 'name', question: copy.setup.operator.name, valid: f.name.length > 0, render: () => <TextField label={copy.setup.operator.name} labelHidden value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="off" autoFocus /> },
        { key: 'mode', question: copy.setup.operator.mode, valid: true, render: () => <Segmented name="operator-mode" label={copy.setup.operator.mode} value={mode} onChange={setMode} options={[{ value: 'modeCredential', label: copy.setup.operator.modeCredential }, { value: 'modePassword', label: copy.setup.operator.modePassword }]} /> },
        ...(mode === 'modePassword' ? [
          { key: 'password', question: copy.setup.operator.password, valid: f.operatorPassword.length > 0, render: () => <TextField label={copy.setup.operator.password} labelHidden type="password" value={f.operatorPassword} onChange={(e) => setF({ ...f, operatorPassword: e.target.value })} autoComplete="off" autoFocus /> },
          { key: 'cert', question: copy.setup.operator.cert, valid: f.certPem.length > 0, render: () => <label className="block"><span className="sr-only">{copy.setup.operator.cert}</span><textarea className={textarea} value={f.certPem} onChange={(e) => setF({ ...f, certPem: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" autoFocus /></label> },
        ] : [
          { key: 'credential', question: copy.setup.operator.credential, hint: copy.setup.operator.whereCredential, valid: f.credential.length > 0, render: () => <label className="block"><span className="sr-only">{copy.setup.operator.credential}</span><textarea className={textarea} value={f.credential} onChange={(e) => setF({ ...f, credential: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" autoFocus /></label> },
        ]),
      ]} />
      <ErrorCard error={err} />
      <ul className="space-y-2">{ops.map((o) => (
        <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-page p-3">
          <span>{o.name}</span>
          <span className="flex items-center gap-2"><StatusPill kind={tone[o.status]}>{copy.settings.operatorStatus[o.status]}</StatusPill>{o.lastError && <span className="text-sm text-danger">{o.lastError}</span>}</span>
        </li>))}</ul>
      {/* No Skip: the business said it sends money, and /complete refuses without a working
          operator. Back (and unticking Send on "What you need") is the honest way out. */}
      <StepFooter onBack={onBack}>
        <Button type="button" onClick={onDone} disabled={!ops.some((o) => o.status === 'verified')}>{copy.setup.next}</Button>
      </StepFooter>
    </div>
  );
}
