import { useState } from 'react';
import { api } from '../../api/client';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { SettingRow } from '../../components/SettingRow';
import { TextField } from '../../components/TextField';
import { Questionnaire } from '../../components/Questionnaire';
import { Segmented } from '../../components/Segmented';
import { StatusPill } from '../../components/StatusPill';
import { toastText } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { B2cApiSetting, Env, EnvSlotView, SecretState } from '../../api/types';
import type { StepUp } from './useStepUp';

type OpMode = 'modePassword' | 'modeCredential';
const B2C_VERSIONS: B2cApiSetting[] = ['auto', 'v1', 'v3'];
const textarea = 'min-h-24 w-full rounded-md border border-line bg-surface p-2 font-mono text-xs text-ink shadow-inner focus:outline-2 focus:-outline-offset-1 focus:outline-brand';

function ModeChoice({ name, mode, onChange }: { name: string; mode: OpMode; onChange: (m: OpMode) => void }) {
  return <Segmented name={name} label={copy.setup.operator.mode} value={mode} onChange={onChange} options={[{ value: 'modeCredential', label: copy.setup.operator.modeCredential }, { value: 'modePassword', label: copy.setup.operator.modePassword }]} />;
}

function secretText(s: SecretState): string {
  if (!s.saved) return copy.settings.secret.notSet;
  return s.last4 ? copy.settings.secret.savedEndsIn(s.last4) : copy.settings.secret.saved;
}

// The key and its verified-at timestamp are always written together (`setDarajaCreds` in
// server/src/settings/service.ts) — this "saved but not yet accepted" branch is unreachable via
// any current code path, but the state is representable, so it gets an explicit line rather than
// silently showing a bare "Saved" with no accepted/not-accepted signal.
function keyStatusText(slot: EnvSlotView): string {
  if (!slot.consumerKey.saved) return copy.settings.secret.notSet;
  if (!slot.credsVerifiedAt) return copy.settings.secret.notYetAccepted;
  return `${secretText(slot.consumerKey)} · ${copy.settings.secret.verifiedAt(when(slot.credsVerifiedAt))}`;
}

export function EnvironmentTab({ env, slot, isActiveMode, reload, stepUp }: { env: Env; slot: EnvSlotView; isActiveMode: boolean; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();

  const [creds, setCreds] = useState({ consumerKey: '', consumerSecret: '' });
  const [pk, setPk] = useState('');
  const [b2cApi, setB2cApi] = useState<B2cApiSetting>(slot.b2cApi.setting);

  const [adding, setAdding] = useState(false);
  const [newOp, setNewOp] = useState({ name: '', operatorPassword: '', certPem: '', credential: '' });
  const [newOpMode, setNewOpMode] = useState<OpMode>('modeCredential');

  const [rotating, setRotating] = useState<string | null>(null);
  const [rotateMode, setRotateMode] = useState<Record<string, OpMode>>({});
  const [rotateForm, setRotateForm] = useState<Record<string, { operatorPassword: string; credential: string }>>({});

  const tone = { pending: 'warn', verified: 'ok', failed: 'bad', disabled: 'muted' } as const;

  return (
    <div className="space-y-6">
      <Card bodyClassName="p-0">
        <SettingRow testId="setting-daraja" label={copy.settings.daraja} changeLabel={copy.settings.replace} value={
          <><span>{copy.setup.daraja.key}: {keyStatusText(slot)}</span><span className="block text-sm text-muted">{copy.setup.daraja.secret}: {secretText(slot.consumerSecret)}</span></>
        }>
          {(close) => (
            <Questionnaire doneLabel={copy.settings.save} onCancel={close} onDone={() => stepUp.ask(copy.settings.confirm.replaceCreds, async (password) => {
              const r = await api.post<{ ok: boolean; message: string }>(`/api/settings/environments/${env}/daraja`, { ...creds, password });
              if (!r.ok) { toast.error(copy.settings.darajaReplaceFailed(r.message)); return; }
              toast.success(r.message);
              setCreds({ consumerKey: '', consumerSecret: '' });
              await reload();
              close();
            })} steps={[
              { key: 'key', question: copy.setup.daraja.key, valid: creds.consumerKey.length > 0, render: () => <TextField label={copy.setup.daraja.key} labelHidden value={creds.consumerKey} onChange={(e) => setCreds({ ...creds, consumerKey: e.target.value })} autoComplete="off" autoFocus /> },
              { key: 'secret', question: copy.setup.daraja.secret, valid: creds.consumerSecret.length > 0, render: () => <TextField label={copy.setup.daraja.secret} labelHidden type="password" value={creds.consumerSecret} onChange={(e) => setCreds({ ...creds, consumerSecret: e.target.value })} autoComplete="off" autoFocus /> },
            ]} />
          )}
        </SettingRow>

        <SettingRow testId="setting-b2c-api" label={copy.settings.b2cApi.title} value={
          <><span>{copy.settings.b2cApi[slot.b2cApi.setting]}</span>{slot.b2cApi.detected && <span className="block text-sm text-muted">{copy.settings.b2cApi.detected(slot.b2cApi.detected, when(slot.b2cApi.detectedAt))}</span>}</>
        }>
          {(close) => (
            <>
              <div role="radiogroup" aria-label={copy.settings.b2cApi.title} className="space-y-2">
                {B2C_VERSIONS.map((v) => (
                  <label key={v} className="flex items-start gap-3">
                    <input type="radio" name={`b2c-api-${env}`} className="mt-1 size-4" checked={b2cApi === v} onChange={() => setB2cApi(v)} />
                    <span><span className="block">{copy.settings.b2cApi[v]}</span><span className="block text-sm text-muted">{copy.settings.b2cApi[`${v}Hint`]}</span></span>
                  </label>
                ))}
              </div>
              {slot.b2cApi.detected && <p className="text-sm text-muted">{copy.settings.b2cApi.detected(slot.b2cApi.detected, when(slot.b2cApi.detectedAt))}</p>}
              <Button disabled={b2cApi === slot.b2cApi.setting} onClick={() => stepUp.ask(copy.settings.confirm.saveB2cApi, async (password) => {
                await api.put(`/api/settings/environments/${env}/b2c-api`, { version: b2cApi, password });
                toast.success(copy.settings.b2cApi.saved);
                await reload();
                close();
              })}>{copy.settings.save}</Button>
            </>
          )}
        </SettingRow>

        <SettingRow testId="setting-passkey" label={copy.settings.passkey} changeLabel={copy.settings.replace} value={secretText(slot.passkey)}>
          {(close) => (
            <>
              <TextField label={copy.settings.newPasskey} type="password" value={pk} onChange={(e) => setPk(e.target.value)} autoComplete="off" />
              <Button disabled={!pk} onClick={() => stepUp.ask(copy.settings.confirm.replacePasskey, async (password) => {
                await api.post(`/api/settings/environments/${env}/passkey`, { passkey: pk, password });
                toast.success(copy.settings.secret.replaced);
                setPk('');
                await reload();
                close();
              })}>{copy.settings.save}</Button>
            </>
          )}
        </SettingRow>

        <SettingRow testId="setting-cert" label={copy.settings.cert.label} value={<><span>{secretText(slot.cert)}</span><span className="block text-sm text-muted">{copy.settings.cert.hint}</span></>} />
      </Card>

      <Card title={copy.settings.operatorsTitle} bodyClassName="p-0" actions={<Button variant="secondary" onClick={() => setAdding((v) => !v)}>{adding ? copy.confirm.cancel : copy.settings.addOperator}</Button>}>
        {!isActiveMode && slot.operators.length > 0 && <p className="px-4 pt-3 text-sm text-muted">{copy.settings.operators.switchToTest(env)}</p>}
        {slot.operators.length === 0 && !adding && <p className="p-4 text-sm text-muted">{copy.settings.secret.notSet}</p>}
        <ul>{slot.operators.map((o) => {
          const rMode = rotateMode[o.id] ?? 'modeCredential';
          const rForm = rotateForm[o.id] ?? { operatorPassword: '', credential: '' };
          const setRForm = (patch: Partial<{ operatorPassword: string; credential: string }>) => setRotateForm({ ...rotateForm, [o.id]: { ...rForm, ...patch } });
          const open = rotating === o.id;
          return (
            <li key={o.id} data-testid={`operator-${o.id}`} className="border-t border-line first:border-t-0">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><span className="font-medium">{o.name}</span><StatusPill kind={tone[o.status]}>{copy.settings.operatorStatus[o.status]}</StatusPill></div>
                  <div className="text-sm text-muted">{copy.settings.expires(new Date(o.expiresAt).toLocaleDateString())}</div>
                  {o.lastError && <div className="text-sm text-danger">{o.lastError}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={!isActiveMode} onClick={async () => {
                    try { await api.post(`/api/settings/operators/${o.id}/probe`); toast.info(copy.settings.probeSent); }
                    catch (e) { toast.error(toastText(e)); }
                    await reload();
                  }}>{copy.settings.probe}</Button>
                  <Button variant="secondary" onClick={() => setRotating(open ? null : o.id)}>{open ? copy.confirm.cancel : copy.settings.rotateCredential}</Button>
                  {o.status !== 'disabled' && <Button variant="danger" onClick={() => stepUp.ask(copy.settings.confirm.disable(o.name), async (password) => { await api.post(`/api/settings/operators/${o.id}/disable`, { password }); toast.success(copy.settings.saved); await reload(); })}>{copy.settings.disable}</Button>}
                </div>
              </div>
              {open && (
                <div className="px-4 pb-4">
                  <Questionnaire doneLabel={rMode === 'modePassword' ? copy.settings.rotate : copy.settings.rotateCredential} onCancel={() => setRotating(null)} onDone={() => stepUp.ask(copy.settings.confirm.rotate(o.name), async (password) => {
                    const body = rMode === 'modePassword' ? { operatorPassword: rForm.operatorPassword, password } : { credential: rForm.credential, password };
                    await api.post(`/api/settings/operators/${o.id}/rotate`, body);
                    toast.success(copy.settings.secret.replaced);
                    setRotateForm({ ...rotateForm, [o.id]: { operatorPassword: '', credential: '' } });
                    setRotating(null);
                    await reload();
                  })} steps={[
                    { key: 'mode', question: copy.setup.operator.mode, valid: true, render: () => <ModeChoice name={`rotate-mode-${o.id}`} mode={rMode} onChange={(m) => setRotateMode({ ...rotateMode, [o.id]: m })} /> },
                    rMode === 'modePassword'
                      ? { key: 'password', question: copy.settings.rotate, valid: rForm.operatorPassword.length > 0, render: () => <TextField label={copy.settings.rotate} labelHidden type="password" value={rForm.operatorPassword} onChange={(e) => setRForm({ operatorPassword: e.target.value })} autoComplete="off" autoFocus /> }
                      : { key: 'credential', question: copy.settings.rotateByCredential, valid: rForm.credential.length > 0, render: () => <label className="block"><span className="sr-only">{copy.settings.rotateByCredential}</span><textarea className={textarea} value={rForm.credential} onChange={(e) => setRForm({ credential: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" autoFocus /></label> },
                  ]} />
                </div>
              )}
            </li>
          );
        })}</ul>
        {adding && (
          <div className="border-t border-line bg-page p-4">
            <Questionnaire doneLabel={copy.setup.operator.add} onCancel={() => setAdding(false)} onDone={() => stepUp.ask(copy.settings.confirm.add(newOp.name), async (password) => {
              const body = newOpMode === 'modePassword'
                ? { name: newOp.name, operatorPassword: newOp.operatorPassword, certPem: newOp.certPem, password }
                : { name: newOp.name, credential: newOp.credential, password };
              await api.post(`/api/settings/environments/${env}/operators`, body);
              toast.success(copy.settings.saved);
              setNewOp({ name: '', operatorPassword: '', certPem: '', credential: '' });
              setAdding(false);
              await reload();
            })} steps={[
              { key: 'name', question: copy.setup.operator.name, valid: newOp.name.length > 0, render: () => <TextField label={copy.setup.operator.name} labelHidden value={newOp.name} onChange={(e) => setNewOp({ ...newOp, name: e.target.value })} autoComplete="off" autoFocus /> },
              { key: 'mode', question: copy.setup.operator.mode, valid: true, render: () => <ModeChoice name={`new-operator-mode-${env}`} mode={newOpMode} onChange={setNewOpMode} /> },
              ...(newOpMode === 'modePassword' ? [
                { key: 'password', question: copy.setup.operator.password, valid: newOp.operatorPassword.length > 0, render: () => <TextField label={copy.setup.operator.password} labelHidden type="password" value={newOp.operatorPassword} onChange={(e) => setNewOp({ ...newOp, operatorPassword: e.target.value })} autoComplete="off" autoFocus /> },
                { key: 'cert', question: copy.setup.operator.cert, valid: newOp.certPem.length > 0, render: () => <label className="block"><span className="sr-only">{copy.setup.operator.cert}</span><textarea className={textarea} value={newOp.certPem} onChange={(e) => setNewOp({ ...newOp, certPem: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" autoFocus /></label> },
              ] : [
                { key: 'credential', question: copy.setup.operator.credential, hint: copy.setup.operator.whereCredential, valid: newOp.credential.length > 0, render: () => <label className="block"><span className="sr-only">{copy.setup.operator.credential}</span><textarea className={textarea} value={newOp.credential} onChange={(e) => setNewOp({ ...newOp, credential: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" autoFocus /></label> },
              ]),
            ]} />
          </div>
        )}
      </Card>
    </div>
  );
}
