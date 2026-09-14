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
import { SharedSection } from './settings/SharedSection';
import { useStepUp } from './settings/useStepUp';

const ENVS: Env[] = ['sandbox', 'production'];

export function Settings() {
  const [v, setV] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [tab, setTab] = useState<Env | null>(null);
  const stepUp = useStepUp();

  const load = useCallback(async () => {
    const d = await api.get<SettingsView>('/api/settings');
    setV(d);
    setTab((prev) => prev ?? d.mode);
    return d;
  }, []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);

  // A live operator update anywhere in the org can affect either tab's list — refresh the whole
  // view. Each section keeps its own in-progress edits in local state, so this never clobbers
  // something the owner is mid-typing (see settings/SharedSection.tsx and EnvironmentTab.tsx).
  useEvents(useCallback((e) => { if (e.type === 'operator.updated') load().catch(() => {}); }, [load]));

  if (err && !v) return <><PageHeader title={copy.settings.title} /><ErrorCard error={err} /></>;
  if (!v || !tab) return <p>{copy.app.loading}</p>;

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

      <OrganisationSection view={v} stepUp={stepUp} />


      <ModeCard view={v} reload={load} stepUp={stepUp} onSwitched={setTab} />

      <div role="tablist" aria-label={copy.settings.mode.title} className="mb-4 flex gap-2 border-b border-gray-200 dark:border-gray-800" onKeyDown={onTabKeyDown}>
        {ENVS.map((e) => (
          <button
            key={e}
            type="button"
            role="tab"
            id={`settings-tab-${e}`}
            aria-selected={tab === e}
            aria-controls={`settings-panel-${e}`}
            tabIndex={tab === e ? 0 : -1}
            className={`flex items-center gap-2 border-b-2 px-4 py-2 text-base ${tab === e ? 'border-emerald-700 font-medium text-emerald-900 dark:border-emerald-500 dark:text-emerald-300' : 'border-transparent text-gray-600 dark:text-gray-400'}`}
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

      <SharedSection view={v} reload={load} stepUp={stepUp} />

      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
