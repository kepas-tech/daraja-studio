import { useState } from 'react';
import { api } from '../../api/client';
import type { B2cApiSetting, SettingsView } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { SettingRow } from '../../components/SettingRow';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { StepUp } from './useStepUp';

const B2C_VERSIONS: B2cApiSetting[] = ['auto', 'v1', 'v3'];

/**
 * The three things a person changes once in a lifetime, if ever: the B2C version for the mode in
 * use, the Safaricom addresses payment news may come from, and the callback secret. Folded shut
 * so the Settings page reads as a short list.
 */
export function AdvancedSection({ view, reload, stepUp }: { view: SettingsView; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();
  const env = view.mode;
  const slot = view.environments[env];
  const [b2cApi, setB2cApi] = useState<B2cApiSetting>(slot.b2cApi.setting);
  const [allow, setAllow] = useState(view.allowlist.join(', '));
  const [secret, setSecret] = useState<string | null>(null);
  const c = copy.settings.organisation;
  return (
    <details className="group mb-6 rounded-md border border-line bg-surface" data-testid="advanced">
      <summary className="cursor-pointer list-none px-4 py-3">
        <span className="text-base font-semibold">{copy.settings.advanced}</span>
        <span className="block text-sm text-muted">{copy.settings.advancedHint}</span>
      </summary>
      <Card bodyClassName="p-0" className="rounded-t-none border-x-0 border-b-0">
        <SettingRow testId="setting-b2c-api" label={`${copy.settings.b2cApi.title} · ${copy.settings.tabs[env]}`} value={
          <><span>{copy.settings.b2cApi[slot.b2cApi.setting]}</span>{slot.b2cApi.detected && <span className="block text-sm text-muted">{copy.settings.b2cApi.detected(slot.b2cApi.detected, when(slot.b2cApi.detectedAt))}</span>}</>
        }>
          {(close) => (
            <>
              <div role="radiogroup" aria-label={copy.settings.b2cApi.title} className="space-y-2">
                {B2C_VERSIONS.map((v) => (
                  <label key={v} className="flex items-start gap-3">
                    <input type="radio" name={`b2c-api-${env}`} className="mt-1 size-4" checked={b2cApi === v} onChange={() => setB2cApi(v)} />
                    <span><span className="block">{copy.settings.b2cApi[v]}</span><span className="block text-sm text-muted">{copy.settings.b2cApi[`${v}Hint`]}</span></span>
                  </label>
                ))}
              </div>
              {slot.b2cApi.detected && <p className="text-sm text-muted">{copy.settings.b2cApi.detected(slot.b2cApi.detected, when(slot.b2cApi.detectedAt))}</p>}
              <Button disabled={b2cApi === slot.b2cApi.setting} onClick={() => stepUp.ask(copy.settings.confirm.saveB2cApi, async (confirm) => {
                await api.put(`/api/settings/environments/${env}/b2c-api`, { version: b2cApi, ...confirm });
                toast.success(copy.settings.b2cApi.saved);
                await reload();
                close();
              })}>{copy.settings.save}</Button>
            </>
          )}
        </SettingRow>

        <SettingRow testId="setting-allowlist" label={copy.settings.allowlist} value={view.allowlist.length ? view.allowlist.join(', ') : c.none}>
          {(close) => (
            <>
              <TextField label={copy.settings.allowlistFieldLabel} value={allow} onChange={(e) => setAllow(e.target.value)} />
              <Button onClick={() => stepUp.ask(copy.settings.confirm.allowlist, async (confirm) => {
                await api.put('/api/settings/allowlist', { allowlist: allow.split(',').map((s) => s.trim()).filter(Boolean), ...confirm });
                toast.success(copy.settings.saved);
                await reload();
                close();
              })}>{copy.settings.save}</Button>
            </>
          )}
        </SettingRow>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-muted">{c.callbackSecret}</div>
            <div className="text-base">{secret ? <code className="break-all">{secret}</code> : copy.settings.hidden}</div>
            <div className="text-sm text-muted">{copy.settings.revealWhy}</div>
          </div>
          {secret
            ? <Button variant="secondary" onClick={() => setSecret(null)}>{copy.settings.hideSecret}</Button>
            : <Button variant="secondary" onClick={() => stepUp.ask(copy.settings.confirm.reveal, async (confirm) => {
                const r = await api.post<{ secret: string }>('/api/settings/install-secret/reveal', { ...confirm });
                setSecret(r.secret);
              })}>{copy.settings.revealSecret}</Button>}
        </div>
      </Card>
    </details>
  );
}
