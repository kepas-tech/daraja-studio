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

type Mode = 'modePassword' | 'modeCredential';

export function Operator({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('modeCredential');
  const [f, setF] = useState({ name: '', operatorPassword: '', certPem: '', credential: '' });
  const [ops, setOps] = useState<OperatorView[]>([]); const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get<SettingsView>('/api/settings').then((v) => setOps(v.environments[v.mode].operators)).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'operator.updated') void load(); }, [load]));
  const tone = { pending: 'warn', verified: 'ok', failed: 'bad', disabled: 'muted' } as const;
  const valid = f.name.length > 0 && (mode === 'modePassword' ? f.operatorPassword.length > 0 && f.certPem.length > 0 : f.credential.length > 0);
  return (
    <div className="space-y-6">
      <form className="space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          const body = mode === 'modePassword'
            ? { name: f.name, operatorPassword: f.operatorPassword, certPem: f.certPem }
            : { name: f.name, credential: f.credential };
          await api.post('/api/setup/operator', body);
          toast.success(copy.settings.saved);
          setF({ name: '', operatorPassword: '', certPem: '', credential: '' });
          await load();
        } catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
      }}>
        <fieldset className="space-y-2">
          <legend className="mb-1 block">{copy.setup.operator.mode}</legend>
          <label className="flex items-center gap-3"><input type="radio" name="operator-mode" checked={mode === 'modeCredential'} onChange={() => setMode('modeCredential')} /> {copy.setup.operator.modeCredential}</label>
          <label className="flex items-center gap-3"><input type="radio" name="operator-mode" checked={mode === 'modePassword'} onChange={() => setMode('modePassword')} /> {copy.setup.operator.modePassword}</label>
        </fieldset>
        <TextField label={copy.setup.operator.name} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="off" />
        {mode === 'modePassword' ? (
          <>
            <TextField label={copy.setup.operator.password} type="password" value={f.operatorPassword} onChange={(e) => setF({ ...f, operatorPassword: e.target.value })} autoComplete="off" />
            <label className="block"><span className="mb-1 block">{copy.setup.operator.cert}</span>
              <textarea className="h-32 w-full rounded-lg border border-gray-300 p-2 font-mono text-xs dark:bg-gray-900 dark:border-gray-700" value={f.certPem} onChange={(e) => setF({ ...f, certPem: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" /></label>
          </>
        ) : (
          <div>
            <label className="block"><span className="mb-1 block">{copy.setup.operator.credential}</span>
              <textarea className="h-32 w-full rounded-lg border border-gray-300 p-2 font-mono text-xs dark:bg-gray-900 dark:border-gray-700" value={f.credential} onChange={(e) => setF({ ...f, credential: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" />
            </label>
            <p className="mt-1 text-sm text-gray-500">{copy.setup.operator.whereCredential}</p>
          </div>
        )}
        <ErrorCard error={err} />
        <Button type="submit" disabled={busy || !valid}>{copy.setup.operator.add}</Button>
      </form>
      <ul className="space-y-2">{ops.map((o) => (
        <li key={o.id} className="flex items-center justify-between rounded-lg border border-gray-200 p-3 dark:border-gray-800">
          <span>{o.name}</span>
          <span className="flex items-center gap-2"><StatusPill kind={tone[o.status]}>{copy.settings.operatorStatus[o.status]}</StatusPill>{o.lastError && <span className="text-sm text-red-700">{o.lastError}</span>}</span>
        </li>))}</ul>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onBack}>{copy.setup.back}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{copy.setup.operator.skip}</Button>
        <Button type="button" onClick={onDone} disabled={!ops.some((o) => o.status === 'verified')}>{copy.setup.next}</Button>
      </div>
    </div>
  );
}
