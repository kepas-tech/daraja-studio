import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { ModuleState } from '../../api/types';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';
import { StepFooter } from './StepFooter';

/**
 * Step one of the tiers-and-modules design, asked here as the design says it should be: "a tier is
 * chosen at setup and changeable at any time".
 *
 * The three names, their sentences and what each turns on come from the server's own registry — the
 * same list the Organisation page draws — so the wizard cannot describe a tier differently from the
 * page that changes it. Business is preselected: it is what a studio that has not thought about it
 * yet should start on, and Platform, with the developer side and the payment feed, stays a
 * deliberate choice. The answer is saved with the same writer and the same audit row the page uses.
 */
export function Tier({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const c = copy.setup.tier;
  const [view, setView] = useState<ModuleState | null>(null);
  const [pick, setPick] = useState('business');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  useEffect(() => {
    // Reading is best-effort: if it fails, the step still offers the three names it can, and the
    // preselected Business is what the server would default to anyway.
    api.get<ModuleState>('/api/modules').then((v) => { setView(v); setPick(v.tier); }).catch(() => setView(null));
  }, []);

  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api.post('/api/setup/tier', { tier: pick }); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };

  const nameOf = (key: string) => view?.modules.find((m) => m.key === key)?.name ?? key;
  const tiers = view?.tiers ?? [];

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h2 className="text-xl font-semibold">{c.title}</h2>
      <p className="text-base">{c.intro}</p>
      <div role="radiogroup" aria-label={c.title} className="space-y-3">
        {tiers.map((t) => (
          <label key={t.key} data-testid={'setup-tier-' + t.key} className={`flex cursor-pointer gap-3 rounded-md border p-4 ${pick === t.key ? 'border-brand bg-brand-tint' : 'border-line hover:bg-page'}`}>
            <input type="radio" name="tier" aria-label={t.name} className="sr-only" checked={pick === t.key} onChange={() => setPick(t.key)} />
            <span className="min-w-0 space-y-1">
              <span className="block text-base font-semibold">{t.name}</span>
              <span className="block text-base text-ink">{t.sentence}</span>
              <span className="block text-sm text-muted">{c.turnsOn}: {t.on.map(nameOf).join(', ')}</span>
            </span>
          </label>
        ))}
      </div>
      <ErrorCard error={err} />
      <StepFooter onBack={onBack}><Button type="submit" disabled={busy}>{copy.setup.next}</Button></StepFooter>
    </form>
  );
}
