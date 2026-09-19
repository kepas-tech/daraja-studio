import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Confirm, ModuleState, ModuleView, TierPreview } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { StatusPill } from '../components/StatusPill';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { useStepUp } from './settings/useStepUp';

/** The name of a menu entry this module adds, in the words the menu itself uses. */
function menuLabel(key: string): string {
  return copy.nav.find((e) => e.key === key)?.label ?? key;
}

/**
 * Step one of the tiers-and-modules design: what this studio does.
 *
 * One page, under Organisation, listing every part of Studio with a switch, a plain sentence and
 * what turning it off hides; above it the tier, with the three names and what each turns on. Nothing
 * here is applied on a whim: a switch and a tier both ask for the password, a tier shows exactly what
 * it will change first, and every change is written to Who did what. Turning a part off hides it and
 * refuses it — it never deletes anything, and turning it back on brings the view back unchanged.
 */
export function Modules() {
  const { status, person } = useSession();
  const toast = useToast();
  const stepUp = useStepUp();
  const c = copy.modulesPage;
  const [v, setV] = useState<ModuleState | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  /** The tier the person is looking at. The server's own tier is only changed by Use, below. */
  const [pick, setPick] = useState<string | null>(null);
  const [preview, setPreview] = useState<TierPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const load = useCallback(async () => { setV(await api.get<ModuleState>('/api/modules')); }, []);
  useEffect(() => { if (person?.is_owner) load().catch((e) => setErr(explainApiError(e))); }, [load, person?.is_owner]);

  if (status === 'loading') return <Loading />;
  if (!person?.is_owner) return <><PageHeader title={c.title} /><p className="text-muted">{c.ownerOnly}</p></>;
  if (err && !v) return <><PageHeader title={c.title} /><ErrorCard error={err} /></>;
  if (!v) return <Loading />;

  const tierName = (key: string) => v.tiers.find((t) => t.key === key)?.name ?? key;
  const chosen = pick ?? v.tier;

  const choose = (key: string) => {
    // Only the view moves here. Nothing reaches the server until Use, below.
    setPick(key === v.tier ? null : key);
    setPreview(null);
  };

  const seePreview = async () => {
    if (!pick) return;
    setPreviewing(true);
    setErr(null);
    try { setPreview(await api.post<TierPreview>('/api/modules/tier/preview', { tier: pick })); }
    catch (e) { setErr(explainApiError(e)); }
    finally { setPreviewing(false); }
  };

  const applyTier = () => {
    if (!pick) return;
    const name = tierName(pick);
    stepUp.ask(c.confirmTier(name), async (confirm: Confirm) => {
      const next = await api.post<ModuleState>('/api/modules/tier', { tier: pick, ...confirm });
      setV(next); setPick(null); setPreview(null); setErr(null);
      toast.success(c.applied(name));
    });
  };

  const toggle = (m: ModuleView) => {
    stepUp.ask(m.on ? c.confirmOff(m.name) : c.confirmOn(m.name), async (confirm: Confirm) => {
      const next = await api.post<ModuleState & { alsoOn: string[] }>('/api/modules/' + m.key, { enabled: !m.on, ...confirm });
      // A switch moves the ground under a preview, so a stale one is dropped rather than shown.
      setV(next); setPreview(null); setErr(null);
      const also = (next.alsoOn ?? []).map((k) => next.modules.find((x) => x.key === k)?.name ?? k);
      toast.success([m.on ? c.turnedOff(m.name) : c.turnedOn(m.name), also.length > 0 ? c.alsoOn(also.join(', ')) : ''].filter(Boolean).join(' '));
    });
  };

  return (
    <>
      <PageHeader title={c.title} subtitle={c.subtitle} />
      <ErrorCard error={err} />

      <Card title={c.tierTitle} className="mb-6" bodyClassName="space-y-4 p-4" data-testid="tier-card">
        <p className="text-sm text-muted">{c.tierSubtitle}</p>
        <div role="radiogroup" aria-label={c.tierTitle} className="space-y-3">
          {v.tiers.map((t) => {
            const on = t.on.map((k) => v.modules.find((m) => m.key === k)?.name ?? k);
            const planned = t.planned.map((k) => v.modules.find((m) => m.key === k)?.name ?? k);
            const here = t.key === v.tier;
            return (
              <label key={t.key} data-testid={`tier-${t.key}`} className={`flex cursor-pointer items-start gap-3 rounded-md border p-4 ${chosen === t.key ? 'border-brand bg-brand-tint/40' : 'border-line'}`}>
                <input type="radio" name="tier" aria-label={t.name} className="sr-only" checked={chosen === t.key} onChange={() => choose(t.key)} />
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">{t.name}</span>
                    {here && <StatusPill kind="ok">{c.current}</StatusPill>}
                  </span>
                  <span className="block text-base text-muted">{t.sentence}</span>
                  <span className="block text-sm"><span className="text-muted">{c.turnsOn}:</span> {on.join(', ')}</span>
                  {planned.length > 0 && <span className="block text-sm text-muted">{c.planned}: {planned.join(', ')} ({c.notBuilt.toLowerCase()})</span>}
                </span>
              </label>
            );
          })}
        </div>

        {pick && (
          <div className="space-y-3 border-t border-line pt-4" data-testid="tier-preview">
            {!preview && <Button type="button" variant="secondary" disabled={previewing} onClick={() => void seePreview()}>{previewing ? c.previewing : c.preview}</Button>}
            {preview && (
              <>
                <p className="text-base font-semibold">{c.previewTitle(tierName(preview.tier))}</p>
                {preview.changes.length === 0
                  ? <p className="text-base">{c.nothing}</p>
                  : (
                    <ul className="space-y-1">
                      {preview.changes.map((ch) => (
                        <li key={ch.key} className="flex flex-wrap items-center justify-between gap-2 text-base">
                          <span>{ch.name}</span>
                          <span className="text-sm text-muted">{ch.to ? c.turnsOn2 : c.turnsOff}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                <Button type="button" onClick={applyTier}>{c.apply(tierName(preview.tier))}</Button>
              </>
            )}
          </div>
        )}

        {!pick && v.departures > 0 && <p className="text-sm text-muted">{c.departures(v.departures)}</p>}
        {!pick && v.matches === null && v.departures > 0 && <p className="text-sm text-muted">{c.noMatch}</p>}
      </Card>

      <Card title={c.partsTitle} className="mb-6" bodyClassName="p-0" data-testid="module-list">
        <ul>
          {v.modules.map((m) => (
            <li key={m.key} data-testid={`module-${m.key}`} className="border-t border-line p-4 first:border-t-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h3 className="text-base font-semibold">{m.name}</h3>
                  <p className="text-base text-muted">{m.sentence}</p>
                  <p className="text-sm"><span className="text-muted">{c.hides}:</span> {m.hides}</p>
                  {m.permissions.length > 0 && <p className="text-sm"><span className="text-muted">{c.adds}:</span> {m.permissions.map((p) => p.label).join(' · ')}</p>}
                  {m.menu.length > 0 && <p className="text-sm"><span className="text-muted">{c.menuLabel}:</span> {m.menu.map(menuLabel).join(' · ')}</p>}
                  {m.needs.length > 0 && <p className="text-sm"><span className="text-muted">{c.needs}:</span> {m.needs.map((n) => n.name).join(' · ')}</p>}
                  {m.heldBy.length > 0 && <p className="text-sm text-muted">{m.heldBy.map((h) => c.holding(h.name)).join(' ')}</p>}
                </div>
                {m.switchable
                  ? <Button type="button" variant="secondary" disabled={m.on && m.heldBy.length > 0} onClick={() => toggle(m)}>{m.on ? c.turnOff : c.turnOn}</Button>
                  : <StatusPill kind="muted">{c.notBuilt}</StatusPill>}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
