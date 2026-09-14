import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { copy } from '../copy/en';
import type { SettingsView } from '../api/types';
import { EnvironmentTab } from './settings/EnvironmentTab';
import { CategoriesSection } from './settings/CategoriesSection';
import { useStepUp } from './settings/useStepUp';
import { Card } from '../components/Card';
import { Loading } from '../components/Loading';
import { Segmented } from '../components/Segmented';
import { useTheme, type Theme } from '../app/theme';

export function Settings() {
  const [v, setV] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const stepUp = useStepUp();
  const [theme, setTheme] = useTheme();
  const themes: { value: Theme; label: string }[] = [{ value: 'system', label: copy.settings.appearance.system }, { value: 'light', label: copy.settings.appearance.light }, { value: 'dark', label: copy.settings.appearance.dark }];

  const load = useCallback(async () => {
    const d = await api.get<SettingsView>('/api/settings');
    setV(d);
    return d;
  }, []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);

  // A live operator update anywhere in the org can affect either tab's list — refresh the whole
  // view. Each section keeps its own in-progress edits in local state, so this never clobbers
  // something the owner is mid-typing (see settings/OrganisationSection.tsx and EnvironmentTab.tsx).
  useEvents(useCallback((e) => { if (e.type === 'operator.updated') load().catch(() => {}); }, [load]));

  if (err && !v) return <><PageHeader title={copy.settings.title} /><ErrorCard error={err} /></>;
  if (!v) return <Loading />;

  return (
    <>
      <PageHeader title={copy.settings.title} safaricom={copy.nav.find((n) => n.key === 'settings')?.safaricom ?? null} />
      <ErrorCard error={err} />

      <Card id="appearance" title={copy.settings.appearance.title} className="mb-6" bodyClassName="p-4">
        <div className="max-w-sm"><Segmented name="theme" label={copy.settings.appearance.title} value={theme} options={themes} onChange={setTheme} /></div>
      </Card>

      <h2 className="mb-3 text-xl font-semibold">{copy.settings.envSettings(v.mode)}</h2>
      <EnvironmentTab key={v.mode} env={v.mode} slot={v.environments[v.mode]} isActiveMode reload={load} stepUp={stepUp} />

      <div className="mt-6"><CategoriesSection items={v.sendCategories} reload={load} stepUp={stepUp} /></div>

      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
