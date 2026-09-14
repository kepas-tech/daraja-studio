import { useState } from 'react';
import { api } from '../../api/client';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { StatusPill } from '../../components/StatusPill';
import { toastText } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { when } from '../../format';
import type { B2cApiSetting, Env, EnvSlotView, SecretState } from '../../api/types';
import type { StepUp } from './useStepUp';
import { Section } from './Section';

type OpMode = 'modePassword' | 'modeCredential';
const B2C_VERSIONS: B2cApiSetting[] = ['auto', 'v1', 'v3'];

function ModeFieldset({ name, mode, onChange }: { name: string; mode: OpMode; onChange: (m: OpMode) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 block text-sm text-muted">{copy.setup.operator.mode}</legend>
      <label className="flex items-center gap-3"><input type="radio" name={name} checked={mode === 'modeCredential'} onChange={() => onChange('modeCredential')} /> {copy.setup.operator.modeCredential}</label>
      <label className="flex items-center gap-3"><input type="radio" name={name} checked={mode === 'modePassword'} onChange={() => onChange('modePassword')} /> {copy.setup.operator.modePassword}</label>
    </fieldset>
  );
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

  const [shortcode, setShortcode] = useState(slot.shortcode ?? '');
  const [creds, setCreds] = useState({ consumerKey: '', consumerSecret: '' });
  const [pk, setPk] = useState('');
  const [b2cApi, setB2cApi] = useState<B2cApiSetting>(slot.b2cApi.setting);

  const [newOp, setNewOp] = useState({ name: '', operatorPassword: '', certPem: '', credential: '' });
  const [newOpMode, setNewOpMode] = useState<OpMode>('modeCredential');
  const newOpValid = newOp.name.length > 0 && (newOpMode === 'modePassword' ? newOp.operatorPassword.length > 0 && newOp.certPem.length > 0 : newOp.credential.length > 0);

  const [rotateMode, setRotateMode] = useState<Record<string, OpMode>>({});
  const [rotateForm, setRotateForm] = useState<Record<string, { operatorPassword: string; credential: string }>>({});

  const tone = { pending: 'warn', verified: 'ok', failed: 'bad', disabled: 'muted' } as const;

  return (
    <div>
      <Section title={copy.settings.shortcode.label}>
        <p>{slot.shortcode ?? copy.settings.secret.notSet}</p>
        <TextField label={copy.settings.shortcode.label} inputMode="numeric" value={shortcode} onChange={(e) => setShortcode(e.target.value)} />
        <Button disabled={!shortcode} onClick={() => stepUp.ask(copy.settings.confirm.saveShortcode, async (password) => {
          const r = await api.put<{ verifiedName: string | null; verifyError: string | null }>(`/api/settings/environments/${env}/shortcode`, { shortcode, password });
          if (r.verifiedName) toast.success(copy.settings.shortcode.knownAs(r.verifiedName));
          else if (r.verifyError) toast.info(`${copy.settings.saved} ${r.verifyError}`);
          else toast.info(copy.settings.shortcode.unverified);
          await reload();
        })}>{copy.settings.save}</Button>
      </Section>

      <Section title={copy.settings.daraja}>
        <p>{copy.setup.daraja.key}: {keyStatusText(slot)}</p>
        <p>{copy.setup.daraja.secret}: {secretText(slot.consumerSecret)}</p>
        <TextField label={copy.setup.daraja.key} value={creds.consumerKey} onChange={(e) => setCreds({ ...creds, consumerKey: e.target.value })} autoComplete="off" />
        <TextField label={copy.setup.daraja.secret} type="password" value={creds.consumerSecret} onChange={(e) => setCreds({ ...creds, consumerSecret: e.target.value })} autoComplete="off" />
        <Button disabled={!creds.consumerKey || !creds.consumerSecret} onClick={() => stepUp.ask(copy.settings.confirm.replaceCreds, async (password) => {
          const r = await api.post<{ ok: boolean; message: string }>(`/api/settings/environments/${env}/daraja`, { ...creds, password });
          if (!r.ok) { toast.error(copy.settings.darajaReplaceFailed(r.message)); return; }
          toast.success(r.message);
          setCreds({ consumerKey: '', consumerSecret: '' });
          await reload();
        })}>{copy.settings.save}</Button>
      </Section>

      <Section title={copy.settings.b2cApi.title}>
        <div role="radiogroup" aria-label={copy.settings.b2cApi.title} className="space-y-2">
          {B2C_VERSIONS.map((v) => (
            <label key={v} className="flex items-start gap-3">
              <input type="radio" name={`b2c-api-${env}`} className="mt-1" checked={b2cApi === v} onChange={() => setB2cApi(v)} />
              <span><span className="block">{copy.settings.b2cApi[v]}</span><span className="block text-sm text-muted">{copy.settings.b2cApi[`${v}Hint`]}</span></span>
            </label>
          ))}
        </div>
        {slot.b2cApi.detected && <p className="text-sm text-muted">{copy.settings.b2cApi.detected(slot.b2cApi.detected, when(slot.b2cApi.detectedAt))}</p>}
        <Button variant="secondary" disabled={b2cApi === slot.b2cApi.setting} onClick={() => stepUp.ask(copy.settings.confirm.saveB2cApi, async (password) => {
          await api.put(`/api/settings/environments/${env}/b2c-api`, { version: b2cApi, password });
          toast.success(copy.settings.b2cApi.saved);
          await reload();
        })}>{copy.settings.save}</Button>
      </Section>

      <Section title={copy.settings.passkey}>
        <p>{secretText(slot.passkey)}</p>
        <TextField label={copy.settings.newPasskey} type="password" value={pk} onChange={(e) => setPk(e.target.value)} autoComplete="off" />
        <Button disabled={!pk} onClick={() => stepUp.ask(copy.settings.confirm.replacePasskey, async (password) => {
          await api.post(`/api/settings/environments/${env}/passkey`, { passkey: pk, password });
          toast.success(copy.settings.secret.replaced);
          setPk('');
          await reload();
        })}>{copy.settings.save}</Button>
      </Section>

      <Section title={copy.settings.operatorsTitle}>
        <p>{copy.settings.cert.label}: {secretText(slot.cert)}</p>
        <p className="text-sm text-muted">{copy.settings.cert.hint}</p>
        {!isActiveMode && slot.operators.length > 0 && <p className="text-sm text-muted">{copy.settings.operators.switchToTest(env)}</p>}
        <ul className="space-y-3">{slot.operators.map((o) => {
          const rMode = rotateMode[o.id] ?? 'modeCredential';
          const rForm = rotateForm[o.id] ?? { operatorPassword: '', credential: '' };
          const rValid = rMode === 'modePassword' ? rForm.operatorPassword.length > 0 : rForm.credential.length > 0;
          const setRForm = (patch: Partial<{ operatorPassword: string; credential: string }>) => setRotateForm({ ...rotateForm, [o.id]: { ...rForm, ...patch } });
          return (
            <li key={o.id} className="space-y-2 rounded-md border border-line p-3">
              <div className="flex items-center justify-between"><span className="font-medium">{o.name}</span><StatusPill kind={tone[o.status]}>{copy.settings.operatorStatus[o.status]}</StatusPill></div>
              <p className="text-sm text-muted">{copy.settings.expires(new Date(o.expiresAt).toLocaleDateString())}</p>
              {o.lastError && <p className="text-sm text-danger">{o.lastError}</p>}
              <ModeFieldset name={`rotate-mode-${o.id}`} mode={rMode} onChange={(m) => setRotateMode({ ...rotateMode, [o.id]: m })} />
              {rMode === 'modePassword'
                ? <TextField label={copy.settings.rotate} type="password" value={rForm.operatorPassword} onChange={(e) => setRForm({ operatorPassword: e.target.value })} autoComplete="off" />
                : <label className="block"><span className="mb-1 block">{copy.settings.rotateByCredential}</span><textarea className="h-20 w-full rounded-md border border-line p-2 font-mono text-xs" value={rForm.credential} onChange={(e) => setRForm({ credential: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" /></label>}
              <div className="flex flex-wrap items-end gap-2">
                <Button variant="secondary" disabled={!rValid} onClick={() => stepUp.ask(copy.settings.confirm.rotate(o.name), async (password) => {
                  const body = rMode === 'modePassword' ? { operatorPassword: rForm.operatorPassword, password } : { credential: rForm.credential, password };
                  await api.post(`/api/settings/operators/${o.id}/rotate`, body);
                  toast.success(copy.settings.secret.replaced);
                  setRotateForm({ ...rotateForm, [o.id]: { operatorPassword: '', credential: '' } });
                  await reload();
                })}>{rMode === 'modePassword' ? copy.settings.rotate : copy.settings.rotateCredential}</Button>
                <Button variant="secondary" disabled={!isActiveMode} onClick={async () => {
                  try { await api.post(`/api/settings/operators/${o.id}/probe`); toast.info(copy.settings.probeSent); }
                  catch (e) { toast.error(toastText(e)); }
                  await reload();
                }}>{copy.settings.probe}</Button>
                {o.status !== 'disabled' && <Button variant="danger" onClick={() => stepUp.ask(copy.settings.confirm.disable(o.name), async (password) => { await api.post(`/api/settings/operators/${o.id}/disable`, { password }); toast.success(copy.settings.saved); await reload(); })}>{copy.settings.disable}</Button>}
              </div>
            </li>
          );
        })}</ul>
        <div className="space-y-3">
          <h3 className="pt-2 font-medium">{copy.settings.add}</h3>
          <TextField label={copy.setup.operator.name} value={newOp.name} onChange={(e) => setNewOp({ ...newOp, name: e.target.value })} autoComplete="off" />
          <ModeFieldset name={`new-operator-mode-${env}`} mode={newOpMode} onChange={setNewOpMode} />
          {newOpMode === 'modePassword' ? (
            <>
              <TextField label={copy.setup.operator.password} type="password" value={newOp.operatorPassword} onChange={(e) => setNewOp({ ...newOp, operatorPassword: e.target.value })} autoComplete="off" />
              <label className="block"><span className="mb-1 block">{copy.setup.operator.cert}</span><textarea className="h-24 w-full rounded-md border border-line p-2 font-mono text-xs" value={newOp.certPem} onChange={(e) => setNewOp({ ...newOp, certPem: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" /></label>
            </>
          ) : (
            <div>
              <label className="block"><span className="mb-1 block">{copy.setup.operator.credential}</span><textarea className="h-24 w-full rounded-md border border-line p-2 font-mono text-xs" value={newOp.credential} onChange={(e) => setNewOp({ ...newOp, credential: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" /></label>
              <p className="mt-1 text-sm text-muted">{copy.setup.operator.whereCredential}</p>
            </div>
          )}
          <Button disabled={!newOpValid} onClick={() => stepUp.ask(copy.settings.confirm.add(newOp.name), async (password) => {
            const body = newOpMode === 'modePassword'
              ? { name: newOp.name, operatorPassword: newOp.operatorPassword, certPem: newOp.certPem, password }
              : { name: newOp.name, credential: newOp.credential, password };
            await api.post(`/api/settings/environments/${env}/operators`, body);
            toast.success(copy.settings.saved);
            setNewOp({ name: '', operatorPassword: '', certPem: '', credential: '' });
            await reload();
          })}>{copy.setup.operator.add}</Button>
        </div>
      </Section>
    </div>
  );
}
