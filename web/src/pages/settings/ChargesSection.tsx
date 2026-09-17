import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { FeeBandView, FeeKind } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { StepUp } from './useStepUp';

type Row = { min: string; max: string; charge: string };
const KINDS: FeeKind[] = ['c2b', 'b2c', 'b2b'];
/** Shillings as the owner types them; the server takes cents, like every amount in Studio. */
const toCents = (v: string) => (v.trim() === '' ? NaN : Math.round(Number(v) * 100));
const control = 'w-28 min-h-9 rounded-md border border-line bg-surface px-2 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';

/**
 * Feature 11. Safaricom's published tariff bands, shown as they are and correctable by the owner
 * with their password. Studio adds no fee of its own, so there is nothing here to earn: this is
 * the figure the send review and History quote. A payment already made keeps the charge it was
 * costed at, so an edit here never rewrites an old row.
 */
export function ChargesSection({ stepUp }: { stepUp: StepUp }) {
  const c = copy.settings.charges;
  const toast = useToast();
  const [rows, setRows] = useState<Record<FeeKind, Row[]> | null>(null);
  const [changed, setChanged] = useState<Partial<Record<FeeKind, string>>>({});
  const [err, setErr] = useState<Error | Explained | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ items: FeeBandView[] }>('/api/fees');
    const next: Record<FeeKind, Row[]> = { c2b: [], b2c: [], b2b: [] };
    const newest: Partial<Record<FeeKind, string>> = {};
    for (const b of r.items) {
      next[b.kind].push({ min: String(b.minCents / 100), max: String(b.maxCents / 100), charge: String(b.chargeCents / 100) });
      const prev = newest[b.kind];
      if (!prev || b.updatedAt > prev) newest[b.kind] = b.updatedAt;
    }
    setRows(next); setChanged(newest); setErr(null);
  }, []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);

  const set = (kind: FeeKind, i: number, field: keyof Row, value: string) => setRows((rs) => {
    if (!rs) return rs;
    return { ...rs, [kind]: rs[kind].map((row, j) => (j === i ? { ...row, [field]: value } : row)) };
  });
  const add = (kind: FeeKind) => setRows((rs) => (rs ? { ...rs, [kind]: [...rs[kind], { min: '', max: '', charge: '' }] } : rs));
  const remove = (kind: FeeKind, i: number) => setRows((rs) => (rs ? { ...rs, [kind]: rs[kind].filter((_, j) => j !== i) } : rs));

  const save = (kind: FeeKind) => {
    const list = rows?.[kind] ?? [];
    const bands = list.map((r) => ({ minCents: toCents(r.min), maxCents: toCents(r.max), chargeCents: toCents(r.charge) }));
    // The server holds the real rules (no overlap, whole shillings, at least one band); this only
    // stops a half-typed row from being sent.
    if (bands.length === 0) { setErr(new Error(c.empty)); return; }
    if (bands.some((b) => ![b.minCents, b.maxCents, b.chargeCents].every((n) => Number.isInteger(n) && n >= 0))) { setErr(new Error(c.error)); return; }
    setErr(null);
    stepUp.ask(c.confirm, async (password) => {
      await api.put('/api/fees/' + kind, { bands, password });
      toast.success(copy.settings.saved);
      await load();
    });
  };

  if (!rows) return null;
  return (
    <Card title={c.title} bodyClassName="p-0">
      <p className="px-4 py-3 text-sm text-muted">{c.intro}</p>
      {KINDS.map((kind) => (
        <div key={kind} data-testid={'charges-' + kind} className="border-t border-line px-4 py-3">
          <h3 className="text-base font-semibold">{c.kinds[kind]}</h3>
          <table className="mt-2 w-full text-base">
            <thead><tr className="text-left text-sm text-muted">
              <th className="py-1 font-medium">{c.from}</th><th className="py-1 font-medium">{c.to}</th><th className="py-1 font-medium">{c.charge}</th><th />
            </tr></thead>
            <tbody>{rows[kind].map((row, i) => (
              <tr key={i}>
                {(['min', 'max', 'charge'] as const).map((field) => (
                  <td key={field} className="py-1 pr-2">
                    <input
                      type="number" min="0" step="1" inputMode="numeric" className={control}
                      aria-label={c.kinds[kind] + ' ' + (field === 'min' ? c.from : field === 'max' ? c.to : c.charge) + ' ' + (i + 1)}
                      value={row[field]} onChange={(e) => set(kind, i, field, e.target.value)}
                    />
                  </td>
                ))}
                <td className="py-1">
                  <button type="button" className="cursor-pointer text-sm text-brand underline" aria-label={c.remove + ' ' + (i + 1)} onClick={() => remove(kind, i)}>{c.remove}</button>
                </td>
              </tr>))}</tbody>
          </table>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => add(kind)}>{c.add}</Button>
            <Button type="button" onClick={() => save(kind)}>{copy.settings.save}</Button>
            <span className="text-sm text-muted">{changed[kind] ? c.lastChanged(when(changed[kind] as string)) : c.notChanged}</span>
          </div>
        </div>
      ))}
      <p className="border-t border-line px-4 py-3 text-sm text-muted">{c.source}</p>
      {err && <div className="px-4 pb-3"><ErrorCard error={err} /></div>}
    </Card>
  );
}
