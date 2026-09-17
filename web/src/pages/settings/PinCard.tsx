import { useState } from 'react';
import { api } from '../../api/client';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import type { StepUp } from './useStepUp';

/**
 * Brief 2, item 3. The PIN behind the lock, set here under Organisation and taken with the owner's
 * own password — the PIN itself never shows on screen, is scrambled with argon2id like a password,
 * and is never written to the log. Six digits and nothing else: the shape a phone keypad makes
 * quick, and the reason the lock is worth having on a phone at all.
 */
export function PinCard({ stepUp }: { stepUp: StepUp }) {
  const { pinSet, refresh } = useSession();
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const c = copy.account.pin;
  const six = /^\d{6}$/.test(pin);
  const ready = six && pin === again;
  const clear = () => { setPin(''); setAgain(''); };

  const save = () => stepUp.ask(c.confirmSet, async (confirm) => {
    await api.put('/api/auth/pin', { newPin: pin, ...confirm });
    clear();
    toast.success(c.saved);
    await refresh();
  });
  const remove = () => stepUp.ask(c.confirmRemove, async (confirm) => {
    await api.del('/api/auth/pin', { ...confirm });
    clear();
    toast.success(c.removed);
    await refresh();
  });

  return (
    <Card title={c.title} className="mb-6" bodyClassName="space-y-3 p-4" data-testid="pin-card">
      <p className="text-sm text-muted">{pinSet ? c.on : c.off}</p>
      <div className="flex flex-wrap items-end gap-3">
        <TextField className="w-40" label={c.newPin} type="password" inputMode="numeric" autoComplete="off" maxLength={6}
          value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <TextField className="w-40" label={c.repeat} type="password" inputMode="numeric" autoComplete="off" maxLength={6}
          value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))} />
        <Button type="button" disabled={!ready} onClick={() => void save()}>{pinSet ? c.change : c.set}</Button>
        {pinSet && <Button type="button" variant="danger" onClick={() => void remove()}>{c.remove}</Button>}
      </div>
      {pin && !six && <p className="text-sm text-danger">{c.sixDigits}</p>}
      {six && again && pin !== again && <p className="text-sm text-danger">{c.mismatch}</p>}
    </Card>
  );
}
