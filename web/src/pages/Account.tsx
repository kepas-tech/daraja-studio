import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client';
import type { Env, SettingsView } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { SettingRow } from '../components/SettingRow';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { ModeCard } from './settings/ModeCard';
import { OrganisationSection } from './settings/OrganisationSection';
import { useStepUp } from './settings/useStepUp';

const ENVS: Env[] = ['sandbox', 'production'];

/** The organisation itself: who it is, which money mode it is in, its shortcodes, and the one way to end it. */
export function Account() {
  const { status, person, org, refresh } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const stepUp = useStepUp();
  const [v, setV] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [shortcodes, setShortcodes] = useState<Record<Env, string>>({ sandbox: '', production: '' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<Error | Explained | null>(null);
  const load = useCallback(async () => {
    const d = await api.get<SettingsView>('/api/settings');
    setV(d);
    setShortcodes({ sandbox: d.environments.sandbox.shortcode ?? '', production: d.environments.production.shortcode ?? '' });
    return d;
  }, []);
  useEffect(() => { if (person?.is_owner) load().catch((e) => setErr(explainApiError(e))); }, [load, person?.is_owner]);

  if (status === 'loading') return <Loading />;
  if (!person?.is_owner) return <><PageHeader title={copy.account.title} /><p className="text-muted">{copy.account.ownerOnly}</p></>;
  if (err && !v) return <><PageHeader title={copy.account.title} /><ErrorCard error={err} /></>;
  if (!v) return <Loading />;

  const wipe = async (password: string) => {
    setDeleting(true); setDeleteError(null);
    try {
      await api.post('/api/org/wipe', { confirmName: org?.name ?? v.org.name, password });
      toast.success(copy.account.deleted);
      setConfirmDelete(false);
      await refresh();
      nav('/');
    } catch (e) { setDeleteError(explainApiError(e)); }
    finally { setDeleting(false); }
  };

  return (
    <>
      <PageHeader title={copy.account.title} />
      <ErrorCard error={err} />
      <OrganisationSection view={v} reload={load} stepUp={stepUp} />
      <ModeCard view={v} reload={load} stepUp={stepUp} onSwitched={() => {}} />
      <Card title={copy.account.shortcodes} className="mb-6" bodyClassName="p-0">
        {ENVS.map((env) => {
          const slot = v.environments[env];
          return (
            <SettingRow key={env} testId={`shortcode-${env}`} label={`${copy.settings.tabs[env]} · ${copy.settings.shortcode.label}`} value={slot.shortcode ?? copy.settings.secret.notSet}>
              {(close) => (
                <>
                  <TextField label={copy.settings.shortcode.label} inputMode="numeric" value={shortcodes[env]} onChange={(e) => setShortcodes({ ...shortcodes, [env]: e.target.value })} />
                  <Button disabled={!shortcodes[env]} onClick={() => stepUp.ask(copy.settings.confirm.saveShortcode, async (password) => {
                    const r = await api.put<{ verifiedName: string | null; verifyError: string | null }>(`/api/settings/environments/${env}/shortcode`, { shortcode: shortcodes[env], password });
                    if (r.verifiedName) toast.success(copy.settings.shortcode.knownAs(r.verifiedName));
                    else if (r.verifyError) toast.info(`${copy.settings.saved} ${r.verifyError}`);
                    else toast.info(copy.settings.shortcode.unverified);
                    await load();
                    close();
                  })}>{copy.settings.save}</Button>
                </>
              )}
            </SettingRow>
          );
        })}
      </Card>
      <Card title={copy.account.deleteTitle} className="border-danger" bodyClassName="space-y-3 p-4">
        <p className="text-sm text-muted">{copy.account.deleteBody}</p>
        <Button variant="danger" onClick={() => { setDeleteError(null); setConfirmDelete(true); }}>{copy.account.deleteButton}</Button>
      </Card>
      <PasswordConfirmDialog open={confirmDelete} danger title={copy.account.deleteTitle} busy={deleting} error={deleteError}
        challenge={{ label: copy.account.typeName(org?.name ?? v.org.name), expected: org?.name ?? v.org.name }}
        onConfirm={(pw) => void wipe(pw)} onCancel={() => setConfirmDelete(false)} />
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
