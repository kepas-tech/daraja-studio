import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client';
import type { Env, SettingsView } from '../../api/types';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { StepUp } from './useStepUp';
import { Section } from './Section';

const ENVS: Env[] = ['sandbox', 'production'];

/**
 * Spec 9. Name, sign-up date, what Safaricom has verified in each environment, the callback secret
 * (moved here from Advanced) and the way to the People page. The editable organisation details stay
 * in SharedSection — one editable name, in one place.
 */
export function OrganisationSection({ view, stepUp }: { view: SettingsView; stepUp: StepUp }) {
  const { org } = useSession();
  const [secret, setSecret] = useState<string | null>(null);
  const name = org?.name ?? view.org.name;

  return (
    <Section title={copy.settings.organisation.title}>
      <p className="text-lg font-medium">{name}</p>
      <p className="text-sm text-muted">{copy.settings.organisation.nameNote}</p>
      {org?.createdAt && <p className="text-sm text-muted">{copy.org.signedUp}: {when(org.createdAt)}</p>}
      {org?.verifiedAt && <p className="text-sm text-muted">{copy.org.verifiedOn}: {when(org.verifiedAt)}</p>}

      <h3 className="pt-2 font-medium">{copy.settings.organisation.verification}</h3>
      <ul className="space-y-2">
        {ENVS.map((e) => {
          const slot = view.environments[e];
          const verified = slot.ready.creds && slot.ready.operator;
          return (
            <li key={e} data-testid={`verification-${e}`} className="rounded-md border border-line p-3">
              <span className="flex flex-wrap items-center gap-2">
                <strong>{copy.settings.tabs[e]}</strong>
                <span className="text-xs text-muted">{copy.org.badgeSafaricom[e]}</span>
                <StatusPill kind={verified ? 'ok' : 'muted'}>{verified ? copy.settings.organisation.verifiedWith : copy.settings.organisation.notVerifiedWith}</StatusPill>
              </span>
              <span className="mt-1 block text-sm text-muted">
                {copy.settings.organisation.shortcode}: {slot.shortcode ?? copy.settings.organisation.none}
                {' · '}{copy.settings.organisation.creds}: {slot.credsVerifiedAt ? when(slot.credsVerifiedAt) : copy.settings.organisation.none}
                {' · '}{copy.settings.organisation.operator}: {slot.ready.operator ? copy.settings.operatorStatus.verified : copy.settings.organisation.none}
              </span>
            </li>
          );
        })}
      </ul>

      <h3 className="pt-2 font-medium">{copy.settings.organisation.people}</h3>
      <p><Link to="/people">{copy.settings.organisation.peopleLink}</Link></p>

      <p className="pt-2 text-sm text-muted">{copy.settings.revealWhy}</p>
      {secret ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="block break-all rounded bg-page p-2">{secret}</code>
          <Button variant="secondary" onClick={() => setSecret(null)}>{copy.settings.hideSecret}</Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => stepUp.ask(copy.settings.confirm.reveal, async (password) => {
          const r = await api.post<{ secret: string }>('/api/settings/install-secret/reveal', { password });
          setSecret(r.secret);
        })}>{copy.settings.revealSecret}</Button>
      )}
    </Section>
  );
}
