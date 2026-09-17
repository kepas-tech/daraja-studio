import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { FingerprintDevice } from '../../api/types';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../../components/ErrorCard';
import { FingerprintIcon } from '../../components/LockIcons';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { StepUp } from './useStepUp';

/**
 * Brief 2, item 3 and item 5b. The PIN behind the lock, set here under Organisation and taken with
 * the owner's own password — the PIN itself never shows on screen, is scrambled with argon2id like a
 * password, and is never written to the log. Six digits and nothing else.
 *
 * Under it, the fingerprint: the devices enrolled, each removable behind the step-up, and the way to
 * add this one. Removing the PIN takes every credential with it, so the two always agree.
 */
export function PinCard({ stepUp }: { stepUp: StepUp }) {
  const { pinSet, pinBio, registerFingerprint, refresh } = useSession();
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [devices, setDevices] = useState<FingerprintDevice[] | null>(null);
  const [bioErr, setBioErr] = useState<Error | Explained | null>(null);
  const c = copy.account.pin;
  const six = /^\d{6}$/.test(pin);
  const ready = six && pin === again;
  const clear = () => { setPin(''); setAgain(''); };

  const loadDevices = useCallback(async () => {
    try { setDevices((await api.get<{ items: FingerprintDevice[] }>('/api/auth/webauthn/credentials')).items); setBioErr(null); }
    catch (e) { setBioErr(explainApiError(e)); }
  }, []);
  useEffect(() => { void loadDevices(); }, [loadDevices]);

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
    await loadDevices();
  });
  const addDevice = async () => {
    const ok = await registerFingerprint();
    if (ok) { toast.success(copy.bio.on); await loadDevices(); } else toast.error(copy.bio.failed);
  };
  const removeDevice = (d: FingerprintDevice) => stepUp.ask(copy.bio.confirmRemove(d.label), async (confirm) => {
    // The identifier rides in the body: a path would put it in logs, and nothing about a credential
    // may be logged (brief 2, item 5b).
    await api.post('/api/auth/webauthn/credentials/remove', { id: d.id, ...confirm });
    toast.success(copy.bio.removed);
    await loadDevices();
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

      <h3 className="pt-2 font-medium">{copy.bio.title}</h3>
      <p className="text-sm text-muted">{copy.bio.body}</p>
      <ErrorCard error={bioErr} />
      {devices && devices.length > 0 && (
        <ul className="space-y-2">
          {devices.map((d) => (
            <li key={d.id} data-testid="bio-device" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3">
              <span className="flex items-center gap-3">
                <FingerprintIcon />
                <span>
                  <strong>{d.label}</strong>
                  <span className="block text-xs text-muted">
                    {copy.bio.added} {when(d.createdAt)} · {copy.bio.lastUsed} {d.lastUsedAt ? when(d.lastUsedAt) : copy.bio.never}
                  </span>
                </span>
              </span>
              <Button type="button" variant="danger" onClick={() => void removeDevice(d)}>{copy.bio.remove}</Button>
            </li>
          ))}
        </ul>
      )}
      {devices && devices.length === 0 && <p className="text-sm text-muted">{copy.bio.none}</p>}
      <Button type="button" variant="secondary" disabled={!pinSet || pinBio} onClick={() => void addDevice()}>{copy.bio.add}</Button>
    </Card>
  );
}
