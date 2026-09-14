import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { copy } from '../copy/en';
import type { Env, SettingsView } from '../api/types';
import { ModeCard } from './settings/ModeCard';
import { EnvironmentTab } from './settings/EnvironmentTab';
import { OrganisationSection } from './settings/OrganisationSection';
import { useStepUp } from './settings/useStepUp';
import { Card } from '../components/Card';
import { Loading } from '../components/Loading';
import { Segmented } from '../components/Segmented';
import { useTheme, type Theme } from '../app/theme';

const ENVS: Env[] = ['sandbox', 'production'];

export function Settings() {
  const [v, setV] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [tab, setTab] = useState<Env | null>(null);
  const stepUp = useStepUp();
  const [theme, setTheme] = useTheme();
  const themes: { value: Theme; label: string }[] = [{ value: 'system', label: copy.settings.appearance.system }, { value: 'light', label: copy.settings.appearance.light }, { value: 'dark', label: copy.settings.appearance.dark }];

  const load = useCallback(async () => {
    const d = await api.get<SettingsView>('/api/settings');
    setV(d);
    setTab((prev) => prev ?? d.mode);
    return d;
  }, []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);

  // A live operator update anywhere in the org can affect either tab's list — refresh the whole
  // view. Each section keeps its own in-progress edits in local state, so this never clobbers
  // something the owner is mid-typing (see settings/OrganisationSection.tsx and EnvironmentTab.tsx).
  useEvents(useCallback((e) => { if (e.type === 'operator.updated') load().catch(() => {}); }, [load]));

  if (err && !v) return <><PageHeader title={copy.settings.title} /><ErrorCard error={err} /></>;
  if (!v || !tab) return <Loading />;

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = ENVS.indexOf(tab);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = ENVS[(i + dir + ENVS.length) % ENVS.length]!;
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${next}`)?.focus());
  };

  return (
    <>
      <PageHeader title={copy.settings.title} safaricom={copy.nav.find((n) => n.key === 'settings')?.safaricom ?? null} />
      <ErrorCard error={err} />

      <Card id="appearance" title={copy.settings.appearance.title} className="mb-6" bodyClassName="p-4">
        <div className="max-w-sm"><Segmented name="theme" label={copy.settings.appearance.title} value={theme} options={themes} onChange={setTheme} /></div>
      </Card>

      <OrganisationSection view={v} reload={load} stepUp={stepUp} />

      <ModeCard view={v} reload={load} stepUp={stepUp} onSwitched={setTab} />

      <div role="tablist" aria-label={copy.settings.mode.title} className="mb-4 flex gap-2 border-b border-line" onKeyDown={onTabKeyDown}>
        {ENVS.map((e) => (
          <button
            key={e}
            type="button"
            role="tab"
            id={`settings-tab-${e}`}
            aria-selected={tab === e}
            aria-controls={`settings-panel-${e}`}
            tabIndex={tab === e ? 0 : -1}
            className={`flex min-h-11 cursor-pointer items-center gap-2 border-b-2 px-4 text-base ${tab === e ? 'border-brand font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'}`}
            onClick={() => setTab(e)}
          >
            {copy.settings.tabs[e]}
            {v.mode === e && <StatusPill kind="ok">{copy.settings.mode.inUse}</StatusPill>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
        <EnvironmentTab key={tab} env={tab} slot={v.environments[tab]} isActiveMode={tab === v.mode} reload={load} stepUp={stepUp} />
      </div>


      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
