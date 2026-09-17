import { useState } from 'react';
import { useSession } from './session';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { FingerprintIcon } from '../components/LockIcons';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';

/**
 * Brief 2, item 5b. After a PIN opens a session on a device with no fingerprint, this asks once,
 * in the page rather than in a browser dialog (the project forbids those). "Not now" is remembered
 * per device, so it never asks twice; turning it on leaves a credential behind and the question
 * cannot come back.
 */
export function FingerprintCard() {
  const { bioPrompt, registerFingerprint, dismissBioPrompt } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!bioPrompt) return null;
  const turnOn = async () => {
    setBusy(true);
    const ok = await registerFingerprint();
    setBusy(false);
    if (ok) toast.success(copy.bio.on); else toast.error(copy.bio.failed);
  };
  return (
    <Card title={<span className="flex items-center gap-2"><FingerprintIcon />{copy.bio.ask}</span>} className="mb-6" bodyClassName="space-y-3 p-4" data-testid="bio-card">
      <p className="text-sm text-muted">{copy.bio.askBody}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => void turnOn()}>{copy.bio.turnOn}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={dismissBioPrompt}>{copy.bio.notNow}</Button>
      </div>
    </Card>
  );
}
