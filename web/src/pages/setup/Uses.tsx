import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { StatusPill } from '../../components/StatusPill';
import { copy } from '../../copy/en';
import { StepFooter } from './StepFooter';
import { useSession } from '../../app/session';

/**
 * The first question that is about the business rather than about Safaricom.
 *
 * Its answers decide which credentials the rest of the wizard asks for. Receiving over a paybill
 * or till needs nothing extra. Sending needs an API operator. The phone prompt (STK Push) is the
 * one way of receiving that needs a passkey, so it is asked on its own, apart from the two main
 * choices, and ticking it counts as receiving.
 */
export function Uses({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const { uses } = useSession();
  const [payOut, setPayOut] = useState(uses?.payOut ?? false);
  const [collect, setCollect] = useState(uses?.collect ?? false);
  const [stk, setStk] = useState(uses?.stk ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const c = copy.setup.uses;
  const chosen = payOut || collect || stk;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/setup/uses', { payOut, collect: collect || stk, stk });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };

  const option = (checked: boolean, set: (v: boolean) => void, label: string, help: string, safaricom: string, badge?: string) => (
    <label className={`flex cursor-pointer gap-3 rounded-md border p-4 ${checked ? 'border-brand bg-brand-tint' : 'border-line hover:bg-page'}`}>
      <input type="checkbox" className="mt-1 size-5 accent-brand" checked={checked} onChange={(e) => set(e.target.checked)} />
      <span>
        <span className="flex flex-wrap items-center gap-2 text-base font-medium">{label}{badge && <StatusPill kind="ok">{badge}</StatusPill>}</span>
        <span className="block text-base text-ink">{help}</span>
        <span className="mt-1 block text-sm text-muted">{safaricom}</span>
      </span>
    </label>
  );

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (chosen) void submit(); }}>
      <h2 className="text-xl font-semibold">{c.title}</h2>
      {option(collect, setCollect, c.collect, c.collectHelp, c.collectSafaricom, c.collectPopular)}
      {option(payOut, setPayOut, c.payOut, c.payOutHelp, c.payOutSafaricom)}
      <div className="space-y-2 border-t border-line pt-4">
        <h3 className="text-base font-semibold">{c.stkTitle}</h3>
        <p className="text-sm text-muted">{c.stkIntro}</p>
        {option(stk, setStk, c.stk, c.stkHelp, c.stkSafaricom)}
      </div>
      {/* Refused server-side too; shown here so the reason arrives before the press, not after. */}
      {!chosen && <p className="text-base text-muted">{c.nothing}</p>}
      <ErrorCard error={err} />
      <StepFooter onBack={onBack}><Button type="submit" disabled={busy || !chosen}>{copy.setup.next}</Button></StepFooter>
    </form>
  );
}
