import { useState } from 'react';
import { api } from '../../api/client';
import type { SettingsView } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { toastText } from '../../components/ErrorCard';
import { SettingRow } from '../../components/SettingRow';
import { StatusPill } from '../../components/StatusPill';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import type { StepUp } from './useStepUp';

/** Studio's own web address, the one Safaricom sends payment news to. */
export function PublicAddressCard({ view, reload, stepUp }: { view: SettingsView; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();
  const [url, setUrl] = useState(view.publicUrl ?? '');
  const [testing, setTesting] = useState(false);
  return (
    <Card className="mb-6" bodyClassName="p-0">
      <SettingRow testId="setting-public-url" label={copy.settings.publicUrl} value={
        <span className="flex flex-wrap items-center gap-2">
          <span>{view.publicUrl ?? copy.settings.organisation.none}</span>
          {view.publicVerifiedAt ? <StatusPill kind="ok">{copy.settings.publicUrlTested(new Date(view.publicVerifiedAt).toLocaleString())}</StatusPill> : <StatusPill kind="bad">{copy.settings.publicUrlNotTested}</StatusPill>}
        </span>
      }>
        {() => (
          <>
            <TextField label={copy.setup.publicUrl.field} hint={copy.setup.publicUrl.hint} value={url} onChange={(e) => setUrl(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => stepUp.ask(copy.settings.confirm.publicUrl, async (password) => {
                await api.put('/api/settings/public-url', { url, password });
                toast.success(copy.settings.saved);
                await reload();
              })}>{copy.settings.save}</Button>
              <Button disabled={testing} onClick={async () => {
                setTesting(true);
                try {
                  const r = await api.post<{ ok: boolean; detail: string }>('/api/settings/public-url/test');
                  if (r.ok) toast.success(r.detail); else toast.error(r.detail);
                } catch (e) { toast.error(toastText(e)); }
                finally { setTesting(false); await reload(); }
              }}>{copy.setup.publicUrl.test}</Button>
            </div>
          </>
        )}
      </SettingRow>
    </Card>
  );
}
