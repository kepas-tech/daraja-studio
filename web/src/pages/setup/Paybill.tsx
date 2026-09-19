import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { ErrorCard } from '../../components/ErrorCard';
import { Flash } from '../../components/Flash';
import { copy } from '../../copy/en';
import { StepFooter } from './StepFooter';

/**
 * Step two of the tiers-and-modules design: the one question setup asks on the production path, and
 * the screen the second answer leads to.
 *
 * Saying no is not a dead end. The answer is recorded, the screen says plainly what the alternative
 * really is — somebody else's paybill, their own account number on it, and their money sitting with
 * KEPAS until it is paid out — and the same step takes a yes later, so anybody who signs up there
 * can come back and set up their own shortcode without starting again.
 */
export function Paybill({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const { paybill, signupUrl, refresh } = useSession();
  const c = copy.setup.paybill;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  // The recorded answer drives the screen, so a reload lands on the same one; this local copy is
  // what moves the screen the moment the answer is made.
  const [answered, setAnswered] = useState<'own' | 'none' | null>(paybill);
  useEffect(() => { setAnswered(paybill); }, [paybill]);

  const answer = async (own: boolean) => {
    setBusy(true); setErr(null);
    try {
      await api.post('/api/setup/paybill', { own });
      setAnswered(own ? 'own' : 'none');
      await refresh();
      if (own) onDone();
    } catch (e) { setErr(e instanceof ApiError ? e : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };

  if (answered === 'none') {
    return (
      <div className="space-y-4" data-testid="paybill-none">
        <h2 className="text-xl font-semibold">{c.noneTitle}</h2>
        {c.noneLines.map((line) => <p key={line} className="text-base">{line}</p>)}
        <Flash tone="neutral">{c.noneNote}</Flash>
        {signupUrl && (
          <a href={signupUrl} target="_blank" rel="noopener" data-testid="signup-link"
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-brand bg-brand px-4 text-base font-semibold text-surface hover:no-underline">
            {c.open}
          </a>
        )}
        <p className="text-sm text-muted">{c.comeBack}</p>
        <ErrorCard error={err} />
        <StepFooter onBack={onBack}>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void answer(true)}>{c.haveOneNow}</Button>
        </StepFooter>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="paybill-question">
      <h2 className="text-xl font-semibold">{c.title}</h2>
      <p className="text-base">{c.intro}</p>
      <ErrorCard error={err} />
      <StepFooter onBack={onBack}>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void answer(false)}>{c.no}</Button>
        <Button type="button" disabled={busy} onClick={() => void answer(true)}>{c.yes}</Button>
      </StepFooter>
    </div>
  );
}
