import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { copy } from '../../copy/en';

/**
 * The first question that is about the business rather than about Safaricom.
 *
 * Its answers decide which credentials the rest of the wizard asks for, so a shop that only takes
 * money is never walked through an API operator it will never use, and one that only pays out is
 * never asked for a passkey. Asking here is what lets every later step be genuinely required.
 */
export function Uses({ onDone }: { onDone: () => void }) {
  const [payOut, setPayOut] = useState(false);
  const [collect, setCollect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const c = copy.setup.uses;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/setup/uses', { payOut, collect });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new Error(copy.error.generic));
    } finally { setBusy(false); }
  };

  const option = (checked: boolean, set: (v: boolean) => void, label: string, help: string, safaricom: string) => (
    <label className={`flex cursor-pointer gap-3 rounded-lg border p-4 ${checked ? 'border-[#186738]' : 'border-[#cccccc]'}`}>
      <input type="checkbox" className="mt-1 size-5 accent-[#186738]" checked={checked} onChange={(e) => set(e.target.checked)} />
      <span>
        <span className="block text-base font-medium">{label}</span>
        <span className="block text-base text-black dark:text-white">{help}</span>
        <span className="mt-1 block text-sm text-black dark:text-[#cccccc]">{safaricom}</span>
      </span>
    </label>
  );

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (payOut || collect) void submit(); }}>
      <h2 className="text-xl font-semibold">{c.title}</h2>
      <p className="text-base text-black dark:text-white">{c.intro}</p>
      {option(payOut, setPayOut, c.payOut, c.payOutHelp, c.payOutSafaricom)}
      {option(collect, setCollect, c.collect, c.collectHelp, c.collectSafaricom)}
      {/* Refused server-side too; shown here so the reason arrives before the press, not after. */}
      {!payOut && !collect && <p className="text-base text-black dark:text-white">{c.nothing}</p>}
      <ErrorCard error={err} />
      <Button type="submit" disabled={busy || (!payOut && !collect)}>{copy.setup.next}</Button>
    </form>
  );
}
