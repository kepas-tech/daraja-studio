import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client';
import type { Env, SettingsView } from '../../api/types';
import { useSession } from '../../app/session';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { toastText } from '../../components/ErrorCard';
import { SettingRow } from '../../components/SettingRow';
import { StatusPill } from '../../components/StatusPill';
import { TextField } from '../../components/TextField';
import { Questionnaire } from '../../components/Questionnaire';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { StepUp } from './useStepUp';

const ENVS: Env[] = ['sandbox', 'production'];

/** Everything about the organisation as read-only rows; each edit form opens on request. */
export function OrganisationSection({ view, reload, stepUp }: { view: SettingsView; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();
  const { org: session, refresh } = useSession();
  const [org, setOrg] = useState(view.org);
  const [url, setUrl] = useState(view.publicUrl ?? '');
  const [allow, setAllow] = useState(view.allowlist.join(', '));
  const [testing, setTesting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const name = session?.name ?? view.org.name;
  const c = copy.settings.organisation;

  return (
    <Card title={c.title} className="mb-6" bodyClassName="p-0">
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
            onDone={() => stepUp.ask(copy.settings.confirm.org, async (password) => {
              await api.put('/api/settings/org', { ...org, password });
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

      <SettingRow testId="setting-public-url" label={copy.settings.publicUrl} value={
        <span className="flex flex-wrap items-center gap-2">
          <span>{view.publicUrl ?? copy.settings.organisation.none}</span>
          {view.publicVerifiedAt ? <StatusPill kind="ok">{copy.settings.publicUrlTested(new Date(view.publicVerifiedAt).toLocaleString())}</StatusPill> : <StatusPill kind="bad">{copy.settings.publicUrlNotTested}</StatusPill>}
        </span>
      }>
        {() => (
          <>
            <TextField label={copy.setup.publicUrl.field} value={url} onChange={(e) => setUrl(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => stepUp.ask(copy.settings.confirm.publicUrl, async (password) => {
                await api.put('/api/settings/public-url', { url, password });
                toast.success(copy.settings.saved);
                await reload();
              })}>{copy.settings.save}</Button>
              <Button disabled={testing} onClick={async () => {
                setTesting(true);
                try {
                  const r = await api.post<{ ok: boolean; detail: string }>('/api/settings/public-url/test');
                  if (r.ok) toast.success(r.detail); else toast.error(r.detail);
                } catch (e) { toast.error(toastText(e)); }
                finally { setTesting(false); await reload(); }
              }}>{copy.setup.publicUrl.test}</Button>
            </div>
          </>
        )}
      </SettingRow>

      <SettingRow label={c.verification} value={
        <ul className="space-y-1">
          {ENVS.map((e) => {
            const slot = view.environments[e];
            const verified = slot.ready.creds && slot.ready.operator;
            return (
              <li key={e} data-testid={`verification-${e}`} className="flex flex-wrap items-center gap-2">
                <span>{copy.settings.tabs[e]}</span>
                <StatusPill kind={verified ? 'ok' : 'muted'}>{verified ? c.verifiedWith : c.notVerifiedWith}</StatusPill>
                <span className="text-sm text-muted">{copy.org.numberLabel(slot.shortcodeKind)}: {slot.shortcode ?? c.none} · {c.creds}: {slot.credsVerifiedAt ? when(slot.credsVerifiedAt) : c.none} · {c.operator}: {slot.ready.operator ? copy.settings.operatorStatus.verified : c.none}{slot.safaricomName ? ` · ${c.knownAs} ${slot.safaricomName}` : ''}</span>
              </li>
            );
          })}
        </ul>
      } />

      <SettingRow label={c.people} value={<Link to="/people">{c.peopleLink}</Link>} />

      <SettingRow testId="setting-allowlist" label={copy.settings.allowlist} value={view.allowlist.length ? view.allowlist.join(', ') : c.none}>
        {(close) => (
          <>
            <TextField label={copy.settings.allowlistFieldLabel} value={allow} onChange={(e) => setAllow(e.target.value)} />
            <Button onClick={() => stepUp.ask(copy.settings.confirm.allowlist, async (password) => {
              await api.put('/api/settings/allowlist', { allowlist: allow.split(',').map((s) => s.trim()).filter(Boolean), password });
              toast.success(copy.settings.saved);
              await reload();
              close();
            })}>{copy.settings.save}</Button>
          </>
        )}
      </SettingRow>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm text-muted">{c.callbackSecret}</div>
          <div className="text-base">{secret ? <code className="break-all">{secret}</code> : copy.settings.hidden}</div>
          <div className="text-sm text-muted">{copy.settings.revealWhy}</div>
        </div>
        {secret
          ? <Button variant="secondary" onClick={() => setSecret(null)}>{copy.settings.hideSecret}</Button>
          : <Button variant="secondary" onClick={() => stepUp.ask(copy.settings.confirm.reveal, async (password) => {
              const r = await api.post<{ secret: string }>('/api/settings/install-secret/reveal', { password });
              setSecret(r.secret);
            })}>{copy.settings.revealSecret}</Button>}
      </div>
    </Card>
  );
}
