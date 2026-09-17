import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import type { Confirm } from '../api/types';
import { useEvents } from '../api/events';
import type { Env, SettingsView } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { SettingRow } from '../components/SettingRow';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { BusinessCard } from './settings/BusinessRow';
import { EnvironmentTab, envMissing } from './settings/EnvironmentTab';
import { ModeCard } from './settings/ModeCard';
import { PinCard } from './settings/PinCard';
import { useStepUp } from './settings/useStepUp';

const ENVS: Env[] = ['sandbox', 'production'];

/**
 * The organisation: its business details, which money mode it is in, each environment's number,
 * Safaricom credentials and operators, who can log in, and the one way to end it. How Studio
 * behaves is on Settings.
 */
export function Account() {
  const { status, person, org, refresh } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const stepUp = useStepUp();
  const [v, setV] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [shown, setShown] = useState<Env | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<Error | Explained | null>(null);
  const load = useCallback(async () => {
    const d = await api.get<SettingsView>('/api/settings');
    setV(d);
    return d;
  }, []);
  useEffect(() => { if (person?.is_owner) load().catch((e) => setErr(explainApiError(e))); }, [load, person?.is_owner]);
  useEvents(useCallback((e) => { if (e.type === 'operator.updated') load().catch(() => {}); }, [load]), typeof EventSource !== 'undefined');

  if (status === 'loading') return <Loading />;
  if (!person?.is_owner) return <><PageHeader title={copy.account.title} /><p className="text-muted">{copy.account.ownerOnly}</p></>;
  if (err && !v) return <><PageHeader title={copy.account.title} /><ErrorCard error={err} /></>;
  if (!v) return <Loading />;

  const wipe = async (confirm: Confirm) => {
    setDeleting(true); setDeleteError(null);
    try {
      await api.post('/api/org/wipe', { confirmName: org?.name ?? v.org.name, ...confirm });
      toast.success(copy.account.deleted);
      setConfirmDelete(false);
      await refresh();
      nav('/');
    } catch (e) { setDeleteError(explainApiError(e)); }
    finally { setDeleting(false); }
  };

  const other = v.mode === 'sandbox' ? 'production' : 'sandbox';
  const showGoLive = v.mode === 'sandbox' && envMissing(v.environments.production).length > 0;

  return (
    <>
      <PageHeader title={copy.account.title} />
      <ErrorCard error={err} />
      <BusinessCard view={v} reload={load} stepUp={stepUp} />
      <ModeCard view={v} reload={load} stepUp={stepUp} onSwitched={() => {}} />
      {showGoLive && (
        <Card title={copy.account.goLive.title} className="mb-6" bodyClassName="space-y-3 p-4" data-testid="go-live-card">
          <p className="text-base">{copy.account.goLive.body}</p>
          <Link to="/go-live"><Button type="button">{copy.account.goLive.button}</Button></Link>
        </Card>
      )}
      {ENVS.filter((e) => e === v.mode).concat(other).map((env) => {
        const open = env === v.mode || shown === env;
        return (
          <section key={env} className="mb-6" data-testid={`env-card-${env}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold">{copy.settings.tabs[env]}</h2>
              {env !== v.mode && <Button type="button" variant="secondary" onClick={() => setShown(open ? null : env)}>{open ? copy.account.env.hide : copy.account.env.show}</Button>}
            </div>
            {open && <EnvironmentTab key={env} env={env} slot={v.environments[env]} isActiveMode={env === v.mode} reload={load} stepUp={stepUp} />}
          </section>
        );
      })}
      <Card className="mb-6" bodyClassName="p-0">
        <SettingRow label={copy.account.people} value={<Link to="/people">{copy.settings.organisation.peopleLink}</Link>} />
      </Card>
      <Card title={copy.account.signOut.title} className="mb-6" bodyClassName="space-y-3 p-4">
        <p className="text-sm text-muted">{copy.account.signOut.body}</p>
        <Button variant="secondary" onClick={() => stepUp.ask(copy.account.signOut.confirm, async (confirm) => {
          await api.post('/api/auth/sign-out-everywhere', { ...confirm });
          toast.success(copy.account.signOut.done);
          await refresh();
          nav('/login');
        })}>{copy.account.signOut.button}</Button>
      </Card>
      <PinCard stepUp={stepUp} />
      <Card title={copy.account.deleteTitle} className="border-danger" bodyClassName="space-y-3 p-4">
        <p className="text-sm text-muted">{copy.account.deleteBody}</p>
        <Button variant="danger" onClick={() => { setDeleteError(null); setConfirmDelete(true); }}>{copy.account.deleteButton}</Button>
      </Card>
      <PasswordConfirmDialog open={confirmDelete} danger title={copy.account.deleteTitle} busy={deleting} error={deleteError}
        challenge={{ label: copy.account.typeName(org?.name ?? v.org.name), expected: org?.name ?? v.org.name }}
        onConfirm={(confirm) => void wipe(confirm)} onCancel={() => setConfirmDelete(false)} />
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
