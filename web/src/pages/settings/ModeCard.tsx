import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { Card } from '../../components/Card';
import { Segmented } from '../../components/Segmented';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import type { Env, SettingsView } from '../../api/types';
import type { StepUp } from './useStepUp';

const ENVS: Env[] = ['sandbox', 'production'];

function missingFor(view: SettingsView, env: Env): string[] {
  const slot = view.environments[env];
  const missing: string[] = [];
  if (!slot.ready.creds) missing.push(copy.settings.mode.notReadyMissing.creds);
  if (!slot.ready.operator) missing.push(copy.settings.mode.notReadyMissing.operator);
  return missing;
}

export function ModeCard({ view, reload, stepUp, onSwitched }: { view: SettingsView; reload: () => Promise<unknown>; stepUp: StepUp; onSwitched: (env: Env) => void }) {
  const toast = useToast();
  const [pendingEnv, setPendingEnv] = useState<Env | null>(null);
  const [confirmShortcode, setConfirmShortcode] = useState('');

  const doSwitch = (env: Env, confirm: string | undefined) => {
    stepUp.ask(copy.settings.confirm.switchMode(env), async (password) => {
      try {
        const r = await api.put<{ mode: Env; ready: { creds: boolean; operator: boolean } }>('/api/settings/mode', { environment: env, confirmShortcode: confirm, password });
        toast.success(copy.settings.mode.switched(r.mode));
        setPendingEnv(null); setConfirmShortcode('');
        await reload();
        onSwitched(r.mode);
      } catch (e) {
        // The production shortcode was mismatched, not the studio password — the field to fix
        // lives inline below, not in this dialog, so report it as a toast and leave the dialog's
        // own retry-in-place behaviour (rethrow) for an actual wrong password.
        if (e instanceof ApiError && e.code === 'confirm_shortcode') { toast.error(e.message); return; }
        throw e;
      }
    });
  };

  const choose = (env: Env) => {
    if (env === view.mode) return;
    if (env === 'production') { setPendingEnv('production'); return; }
    setPendingEnv(null); setConfirmShortcode('');
    doSwitch('sandbox', undefined);
  };

  const missing = missingFor(view, view.mode);

  return (
    <Card title={copy.settings.mode.title} className="mb-6" bodyClassName="space-y-3 p-4">
      <Segmented name="mode" label={copy.settings.mode.title} value={view.mode} onChange={choose}
        options={ENVS.map((env) => ({ value: env, label: copy.settings.mode[env] }))} />
      <p className="text-sm text-muted">{copy.settings.mode[`${view.mode}Hint`]}</p>
      {pendingEnv === 'production' && (
        <div className="space-y-3 border-t border-line pt-4">
          <TextField label={copy.settings.mode.confirmShortcode} value={confirmShortcode} onChange={(e) => setConfirmShortcode(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="secondary" type="button" onClick={() => { setPendingEnv(null); setConfirmShortcode(''); }}>{copy.confirm.cancel}</Button>
            <Button type="button" disabled={!confirmShortcode} onClick={() => doSwitch('production', confirmShortcode)}>{copy.settings.confirm.switchMode('production')}</Button>
          </div>
        </div>
      )}
      {missing.length > 0 && <p className="text-sm text-muted">{copy.settings.mode.notReady(view.mode, missing)}</p>}
    </Card>
  );
}
