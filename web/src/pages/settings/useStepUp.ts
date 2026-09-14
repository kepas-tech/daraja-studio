import { useState } from 'react';
import { ApiError } from '../../api/client';
import { copy } from '../../copy/en';

export interface StepUp {
  ask: (title: string, run: (password: string) => Promise<void>) => void;
  dialogProps: { open: boolean; title: string; busy: boolean; error: Error | null; onConfirm: (password: string) => void; onCancel: () => void };
}

// One password dialog shared across the whole Settings page (mirrors the pre-existing page's
// single `confirm` state) — every step-up action asks it to open rather than each section
// owning its own dialog instance.
export function useStepUp(): StepUp {
  const [pending, setPending] = useState<{ title: string; run: (password: string) => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const ask = (title: string, run: (password: string) => Promise<void>) => { setError(null); setPending({ title, run }); };
  const onCancel = () => { if (!busy) setPending(null); };
  const onConfirm = async (password: string) => {
    if (!pending) return;
    setBusy(true); setError(null);
    try { await pending.run(password); setPending(null); }
    catch (e) { setError(e instanceof ApiError ? e : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };

  return { ask, dialogProps: { open: !!pending, title: pending?.title ?? '', busy, error, onConfirm: (pw) => void onConfirm(pw), onCancel } };
}
