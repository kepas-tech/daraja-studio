import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { copy } from '../copy/en';
import { Button } from './Button';
import { TextField } from './TextField';

interface Check { name: string | null; available: boolean; reason: string | null; message: string | null; suggestions: string[] }

/**
 * Migration 052: a name as an account number (JOHN), beside the digits. The name must be free across
 * the whole paybill, so it is checked first; a taken name comes with free ones to pick from.
 */
export function NameChooser({ accountId, current, onChanged }: { accountId: string; current: string | null; onChanged: () => void }) {
  const c = copy.namedNumber;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function ask() {
    setErr(null);
    setCheck(await api.get<Check>(`/api/accounts/name-check?name=${encodeURIComponent(text)}&accountId=${accountId}`));
  }
  async function take(name: string) {
    setBusy(true); setErr(null);
    try {
      await api.put(`/api/accounts/${accountId}/name`, { name });
      setOpen(false); setText(''); setCheck(null);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'name_taken') {
        const d = e.details as { reason: string; suggestions: string[] };
        setCheck({ name: name.toUpperCase(), available: false, reason: d.reason, message: e.message, suggestions: d.suggestions });
      } else setErr(e instanceof Error ? e.message : c.failed);
    } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await api.del(`/api/accounts/${accountId}/name`); onChanged(); } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm" data-testid={'named-' + accountId}>
        {current ? <span>{c.current(current)}</span> : null}
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>{current ? c.change : c.choose}</Button>
        {current ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void remove()}>{c.remove}</Button> : null}
      </span>
    );
  }
  return (
    <form className="space-y-2 rounded-md border border-line p-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <TextField label={c.label} hint={c.hint} value={text} maxLength={12} onChange={(e) => { setText(e.target.value); setCheck(null); }} error={err ?? undefined} />
      {check && check.available && check.name && (
        <p className="text-sm">{c.free(check.name)} <Button type="button" disabled={busy} onClick={() => void take(check.name!)}>{c.use(check.name)}</Button></p>
      )}
      {check && !check.available && (
        <div className="space-y-1 text-sm">
          <p>{check.message}</p>
          {check.suggestions.length > 0 && <p className="text-muted">{c.tryThese}</p>}
          <span className="flex flex-wrap gap-2">
            {check.suggestions.map((s) => <Button key={s} type="button" variant="secondary" disabled={busy} onClick={() => void take(s)}>{s}</Button>)}
          </span>
        </div>
      )}
      <span className="flex flex-wrap gap-2">
        <Button type="submit" disabled={text.trim().length < 3}>{c.check}</Button>
        <Button type="button" variant="secondary" onClick={() => { setOpen(false); setCheck(null); setErr(null); }}>{c.cancel}</Button>
      </span>
    </form>
  );
}
