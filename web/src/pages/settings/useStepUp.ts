import { useState } from 'react';
import { ApiError } from '../../api/client';
import type { Confirm } from '../../api/types';
import { useSession } from '../../app/session';
import { copy } from '../../copy/en';

export interface StepUp {
  ask: (title: string, run: (confirm: Confirm) => Promise<void>) => void;
  dialogProps: { open: boolean; title: string; busy: boolean; error: Error | null; onConfirm: (confirm: Confirm) => void; onCancel: () => void; pin: boolean };
}

// One confirmation dialog shared across the whole page (mirrors the pre-existing page's single
// `confirm` state) — every step-up action asks it to open rather than each section owning its own
// dialog instance. It asks for the PIN when one is set (brief 2, item 3); the session knows.
export function useStepUp(): StepUp {
  const { pinSet } = useSession();
  const [pending, setPending] = useState<{ title: string; run: (confirm: Confirm) => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const ask = (title: string, run: (confirm: Confirm) => Promise<void>) => { setError(null); setPending({ title, run }); };
  const onCancel = () => { if (!busy) setPending(null); };
  const onConfirm = async (confirm: Confirm) => {
    if (!pending) return;
    setBusy(true); setError(null);
    try { await pending.run(confirm); setPending(null); }
    catch (e) { setError(e instanceof ApiError ? e : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };

  return { ask, dialogProps: { open: !!pending, title: pending?.title ?? '', busy, error, pin: pinSet, onConfirm: (c) => void onConfirm(c), onCancel } };
}
