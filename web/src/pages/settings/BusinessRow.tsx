import { useState } from 'react';
import { api } from '../../api/client';
import type { SettingsView } from '../../api/types';
import { useSession } from '../../app/session';
import { Card } from '../../components/Card';
import { SettingRow } from '../../components/SettingRow';
import { TextField } from '../../components/TextField';
import { Questionnaire } from '../../components/Questionnaire';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { StepUp } from './useStepUp';

/** The business itself: its name and the two contact numbers Safaricom holds. */
export function BusinessCard({ view, reload, stepUp }: { view: SettingsView; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();
  const { org: session, refresh } = useSession();
  const [org, setOrg] = useState(view.org);
  const name = session?.name ?? view.org.name;
  const c = copy.settings.organisation;
  return (
    <Card title={copy.account.business} className="mb-6" bodyClassName="p-0">
      <SettingRow testId="setting-org" label={copy.settings.org} value={
        <>
          <span className="font-semibold">{name}</span>
          {name === 'My organisation' && <span className="block text-sm text-muted">{c.defaultName}</span>}
          {(view.org.nominatedNumber || view.org.notificationPhone) && <span className="block text-sm text-muted">{copy.settings.nominated}: {view.org.nominatedNumber || c.none} · {copy.settings.notify}: {view.org.notificationPhone || c.none}</span>}
          {session?.createdAt && <span className="block text-sm text-muted">{copy.org.signedUp}: {when(session.createdAt)}{session.verifiedAt && <> · {copy.org.verifiedOn}: {when(session.verifiedAt)}</>}</span>}
        </>
      }>
        {(close) => (
          <Questionnaire doneLabel={copy.settings.save} onCancel={close} intro={copy.settings.orgPortalNote(copy.settings.portalOnly)}
            onDone={() => stepUp.ask(copy.settings.confirm.org, async (confirm) => {
              await api.put('/api/settings/org', { ...org, ...confirm });
              toast.success(copy.settings.saved);
              // The name sits in the menu header and the page title; both read the session.
              await Promise.all([reload(), refresh()]);
              close();
            })}
            steps={[
              { key: 'name', question: copy.setup.org.name, valid: org.name.trim().length > 0, render: () => <TextField label={copy.setup.org.name} labelHidden value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} autoFocus /> },
              { key: 'nominated', question: copy.setup.org.nominated, valid: /^254\d{9}$/.test(org.nominatedNumber), render: () => <TextField label={copy.setup.org.nominated} labelHidden value={org.nominatedNumber} onChange={(e) => setOrg({ ...org, nominatedNumber: e.target.value })} autoFocus /> },
              { key: 'notify', question: copy.setup.org.notify, valid: /^254\d{9}$/.test(org.notificationPhone), render: () => <TextField label={copy.setup.org.notify} labelHidden value={org.notificationPhone} onChange={(e) => setOrg({ ...org, notificationPhone: e.target.value })} autoFocus /> },
            ]} />
        )}
      </SettingRow>
    </Card>
  );
}
