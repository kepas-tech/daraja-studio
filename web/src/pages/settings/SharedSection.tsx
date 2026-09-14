import { useState } from 'react';
import { api } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { StatusPill } from '../../components/StatusPill';
import { toastText } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import type { SettingsView } from '../../api/types';
import type { StepUp } from './useStepUp';
import { Section } from './Section';

export function SharedSection({ view, reload, stepUp }: { view: SettingsView; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();
  const [org, setOrg] = useState(view.org);
  const [url, setUrl] = useState(view.publicUrl ?? '');
  const [allow, setAllow] = useState(view.allowlist.join(', '));
  const [testing, setTesting] = useState(false);

  return (
    <>
      <Section title={copy.settings.org}>
        <TextField label={copy.setup.org.name} value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} />
        <TextField label={copy.setup.org.nominated} value={org.nominatedNumber} onChange={(e) => setOrg({ ...org, nominatedNumber: e.target.value })} />
        <TextField label={copy.setup.org.notify} value={org.notificationPhone} onChange={(e) => setOrg({ ...org, notificationPhone: e.target.value })} />
        <p className="text-sm text-gray-500">{copy.settings.orgPortalNote(copy.settings.portalOnly)}</p>
        <Button onClick={() => stepUp.ask(copy.settings.confirm.org, async (password) => {
          await api.put('/api/settings/org', { ...org, password });
          toast.success(copy.settings.saved);
          await reload();
        })}>{copy.settings.save}</Button>
      </Section>

      <Section title={copy.settings.publicUrl}>
        <p>{view.publicVerifiedAt ? <StatusPill kind="ok">{copy.settings.publicUrlTested(new Date(view.publicVerifiedAt).toLocaleString())}</StatusPill> : <StatusPill kind="bad">{copy.settings.publicUrlNotTested}</StatusPill>}</p>
        <TextField label={copy.setup.publicUrl.field} value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="flex gap-2">
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
      </Section>

      <Section title={copy.settings.allowlist}>
        <TextField label={copy.settings.allowlistFieldLabel} value={allow} onChange={(e) => setAllow(e.target.value)} />
        <Button onClick={() => stepUp.ask(copy.settings.confirm.allowlist, async (password) => {
          await api.put('/api/settings/allowlist', { allowlist: allow.split(',').map((s) => s.trim()).filter(Boolean), password });
          toast.success(copy.settings.saved);
          await reload();
        })}>{copy.settings.save}</Button>
      </Section>
    </>
  );
}
