import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api/client';
import { useEvents } from '../api/events';
import type { EnvSlotView, SettingsView } from '../api/types';
import { useSession } from '../app/session';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { PhoneInput } from '../components/PhoneInput';
import { Questionnaire } from '../components/Questionnaire';
import { SafaricomHow } from '../components/SafaricomHow';
import { Segmented } from '../components/Segmented';
import { StatusPill } from '../components/StatusPill';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { how } from '../copy/guide';
import { normalizeKe } from '../format';

type StepKey = 'need' | 'number' | 'keys' | 'switch' | 'passkey' | 'operator' | 'done';
type OpMode = 'modePassword' | 'modeCredential';
const textarea = 'min-h-24 w-full rounded-md border border-line bg-surface p-2 font-mono text-xs text-ink shadow-inner focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
const c = copy.goLive;

/** The steps this studio needs, from what it said it uses at setup. Done ones stay, so the counter is honest. */
export function stepsFor(v: SettingsView): StepKey[] {
  const s: StepKey[] = ['need', 'number', 'keys', 'switch'];
  if (v.uses?.stk) s.push('passkey');
  if (v.uses?.payOut !== false) s.push('operator');
  s.push('done');
  return s;
}

interface StepProps {
  prod: EnvSlotView;
  live: boolean;
  busy: boolean;
  footer: (primary: ReactNode) => ReactNode;
  next: () => void;
  back: () => void;
  withPassword: (fn: (pw: string) => Promise<void>) => void;
  reload: () => Promise<SettingsView>;
  setErr: (e: Error | Explained | null) => void;
}

const Done = ({ text }: { text: string }) => <Flash tone="success" role="status"><p>{text}</p></Flash>;

function NumberStep(p: StepProps) {
  const toast = useToast();
  const [n, setN] = useState(p.prod.shortcode ?? '');
  const done = !!p.prod.shortcode;
  const unchanged = done && n === p.prod.shortcode;
  return (
    <>
      <p className="text-base text-muted">{c.number.intro}</p>
      {done && <Done text={c.number.done(p.prod.safaricomName ?? null)} />}
      <SafaricomHow links={[how.number]} />
      <TextField label={copy.settings.shortcode.label} inputMode="numeric" value={n} onChange={(e) => setN(e.target.value)} autoFocus />
      {p.footer(unchanged
        ? <Button type="button" onClick={p.next}>{c.continueLabel}</Button>
        : <Button type="button" disabled={p.busy || !/^\d{5,7}$/.test(n)} onClick={() => p.withPassword(async (pw) => {
            const r = await api.put<{ verifiedName: string | null; verifyError: string | null }>('/api/settings/environments/production/shortcode', { shortcode: n, password: pw });
            toast.success(r.verifiedName ? copy.settings.shortcode.knownAs(r.verifiedName) : copy.settings.saved);
            await p.reload(); p.next();
          })}>{copy.settings.save}</Button>)}
    </>
  );
}

function KeysStep(p: StepProps) {
  const toast = useToast();
  const [f, setF] = useState({ consumerKey: '', consumerSecret: '' });
  const done = p.prod.ready.creds;
  return (
    <>
      <p className="text-base text-muted">{c.keys.intro}</p>
      {done && <Done text={c.keys.done} />}
      <SafaricomHow links={[how.keys]} />
      {done
        ? p.footer(<Button type="button" onClick={p.next}>{c.continueLabel}</Button>)
        : <Questionnaire doneLabel={copy.settings.save} busy={p.busy} onCancel={p.back} onDone={() => p.withPassword(async (pw) => {
            const r = await api.post<{ ok: boolean; message: string }>('/api/settings/environments/production/daraja', { ...f, password: pw });
            if (!r.ok) { p.setErr(new Error(r.message)); return; }
            toast.success(r.message);
            await p.reload(); p.next();
          })} steps={[
            { key: 'key', question: copy.setup.daraja.key, valid: f.consumerKey.length > 0, render: () => <TextField label={copy.setup.daraja.key} labelHidden value={f.consumerKey} onChange={(e) => setF({ ...f, consumerKey: e.target.value })} autoComplete="off" autoFocus /> },
            { key: 'secret', question: copy.setup.daraja.secret, valid: f.consumerSecret.length > 0, render: () => <TextField label={copy.setup.daraja.secret} labelHidden type="password" value={f.consumerSecret} onChange={(e) => setF({ ...f, consumerSecret: e.target.value })} autoComplete="off" autoFocus /> },
          ]} />}
    </>
  );
}

function SwitchStep(p: StepProps) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  return (
    <>
      <p className="text-base text-muted">{c.switchMode.intro}</p>
      {p.live && <Done text={c.switchMode.done} />}
      {!p.live && <TextField label={c.switchMode.field} inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />}
      {p.footer(p.live
        ? <Button type="button" onClick={p.next}>{c.continueLabel}</Button>
        : <Button type="button" disabled={p.busy || !typed} onClick={() => p.withPassword(async (pw) => {
            try {
              await api.put('/api/settings/mode', { environment: 'production', confirmShortcode: typed, password: pw });
            } catch (e) { if (e instanceof ApiError && e.code === 'confirm_shortcode') { toast.error(e.message); return; } throw e; }
            toast.success(copy.settings.mode.switched('production'));
            await p.reload(); p.next();
          })}>{c.switchMode.button}</Button>)}
    </>
  );
}

function PasskeyStep(p: StepProps) {
  const [passkey, setPasskey] = useState('');
  const [phone, setPhone] = useState('');
  const [refused, setRefused] = useState(false);
  const normalised = normalizeKe(phone);
  const done = !!p.prod.passkeyProven;
  const pk = copy.setup.passkey;
  return (
    <>
      <p className="text-base text-muted">{c.passkey.intro}</p>
      {done && <Done text={pk.proven} />}
      {refused && <Flash tone="danger" role="alert"><p className="font-semibold text-danger">{pk.failedTitle}</p><p>{pk.failedBody}</p></Flash>}
      <SafaricomHow links={[how.passkeyProduction]} />
      {done
        ? p.footer(<Button type="button" onClick={p.next}>{c.continueLabel}</Button>)
        : <Questionnaire doneLabel={refused ? pk.retry : pk.test} busy={p.busy} onCancel={p.back} onDone={() => { if (!normalised) return; p.withPassword(async (pw) => {
            setRefused(false);
            const r = await api.post<{ proven: boolean }>('/api/settings/environments/production/passkey/prove', { passkey: passkey.trim(), phone: normalised, password: pw });
            if (!r.proven) { setRefused(true); return; }
            await p.reload(); p.next();
          }); }} steps={[
            { key: 'passkey', question: pk.field, valid: passkey.trim().length > 0, render: () => <TextField label={pk.field} labelHidden type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} autoComplete="off" autoFocus /> },
            { key: 'phone', question: pk.phone, hint: pk.phoneHelp, valid: !!normalised, render: () => <PhoneInput label={pk.phone} labelHidden value={phone} onChange={setPhone} autoFocus /> },
          ]} />}
    </>
  );
}

function OperatorStep(p: StepProps) {
  const toast = useToast();
  const [mode, setMode] = useState<OpMode>('modeCredential');
  const [f, setF] = useState({ name: '', operatorPassword: '', certPem: '', credential: '' });
  const done = p.prod.ready.operator;
  const tone = { pending: 'warn', verified: 'ok', failed: 'bad', disabled: 'muted' } as const;
  const o = copy.setup.operator;
  return (
    <>
      <p className="text-base text-muted">{c.operator.intro}</p>
      {done && <Done text={o.verified} />}
      <SafaricomHow links={mode === 'modePassword' ? [how.operatorCreate, how.operatorPassword, how.certificateProduction] : [how.operatorCreate, how.operatorPassword, how.credential]} />
      {p.prod.operators.length > 0 && <ul className="space-y-2">{p.prod.operators.map((op) => (
        <li key={op.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-page p-3">
          <span>{op.name}</span>
          <span className="flex items-center gap-2"><StatusPill kind={tone[op.status]}>{copy.settings.operatorStatus[op.status]}</StatusPill>{op.lastError && <span className="text-sm text-danger">{op.lastError}</span>}</span>
        </li>))}</ul>}
      {done
        ? p.footer(<Button type="button" onClick={p.next}>{c.continueLabel}</Button>)
        : <Questionnaire doneLabel={o.add} busy={p.busy} onCancel={p.back} onDone={() => p.withPassword(async (pw) => {
            const body = mode === 'modePassword'
              ? { name: f.name, operatorPassword: f.operatorPassword, certPem: f.certPem, password: pw }
              : { name: f.name, credential: f.credential, password: pw };
            await api.post('/api/settings/environments/production/operators', body);
            toast.info(o.pending);
            setF({ name: '', operatorPassword: '', certPem: '', credential: '' });
            await p.reload();
          })} steps={[
            { key: 'name', question: o.name, hint: o.nameHint, valid: f.name.length > 0, render: () => <TextField label={o.name} labelHidden value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="off" autoFocus /> },
            { key: 'mode', question: o.mode, valid: true, render: () => <Segmented name="go-live-operator-mode" label={o.mode} value={mode} onChange={setMode} options={[{ value: 'modeCredential', label: o.modeCredential }, { value: 'modePassword', label: o.modePassword }]} /> },
            ...(mode === 'modePassword' ? [
              { key: 'password', question: o.password, hint: o.passwordHint, valid: f.operatorPassword.length > 0, render: () => <TextField label={o.password} labelHidden type="password" value={f.operatorPassword} onChange={(e) => setF({ ...f, operatorPassword: e.target.value })} autoComplete="off" autoFocus /> },
              { key: 'cert', question: o.cert, valid: f.certPem.length > 0, render: () => <label className="block"><span className="sr-only">{o.cert}</span><textarea className={textarea} value={f.certPem} onChange={(e) => setF({ ...f, certPem: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" autoFocus /></label> },
            ] : [
              { key: 'credential', question: o.credential, hint: o.whereCredential, valid: f.credential.length > 0, render: () => <label className="block"><span className="sr-only">{o.credential}</span><textarea className={textarea} value={f.credential} onChange={(e) => setF({ ...f, credential: e.target.value })} autoComplete="off" spellCheck={false} autoCorrect="off" autoFocus /></label> },
            ]),
          ]} />}
    </>
  );
}

const STEPS: Record<Exclude<StepKey, 'need' | 'done'>, (p: StepProps) => ReactNode> = { number: NumberStep, keys: KeysStep, switch: SwitchStep, passkey: PasskeyStep, operator: OperatorStep };

/**
 * From pretend money to real money, one screen at a time, in the wizard's own style. The password
 * is asked once and reused for every save; a refusal of it clears it and asks again. Each step
 * reads the Production slot, so a step already done shows as done and a reload never repeats work.
 * The switch comes before the passkey and the operator, because Safaricom proves those through the
 * mode in use.
 */
export function GoLive() {
  const { person } = useSession();
  const nav = useNavigate();
  const [v, setV] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [i, setI] = useState(0);
  const [password, setPassword] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState<((pw: string) => void) | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { const d = await api.get<SettingsView>('/api/settings'); setV(d); return d; }, []);
  useEffect(() => { if (person?.is_owner) load().catch((e) => setErr(explainApiError(e))); }, [load, person?.is_owner]);
  useEvents(useCallback((e) => { if (e.type === 'operator.updated') load().catch(() => {}); }, [load]), typeof EventSource !== 'undefined');

  if (!person?.is_owner) return <><PageHeader title={c.title} /><p className="text-muted">{copy.account.ownerOnly}</p></>;
  if (err && !v) return <><PageHeader title={c.title} /><ErrorCard error={err} /></>;
  if (!v) return <Loading />;

  const prod = v.environments.production;
  const steps = stepsFor(v);
  const step = steps[Math.min(i, steps.length - 1)]!;
  const live = v.mode === 'production';
  const allDone = live && prod.ready.creds && (!v.uses?.stk || !!prod.passkeyProven) && (v.uses?.payOut === false || prod.ready.operator);
  if (allDone && step !== 'done') {
    return (
      <>
        <PageHeader title={c.title} safaricom={c.safaricom} />
        <Flash tone="success"><p className="font-semibold">{c.alreadyLive}</p><p>{c.alreadyLiveHint} <Link to="/account">{copy.account.title}</Link></p></Flash>
      </>
    );
  }

  /** Run `fn` with the password, asking for it first when this is the first save or the last one was refused. */
  const withPassword = (fn: (pw: string) => Promise<void>) => {
    const run = (pw: string) => {
      setBusy(true); setErr(null);
      fn(pw).catch((e) => {
        if (e instanceof ApiError && e.status === 403) { setPassword(null); setPending(() => run); setAsking(true); return; }
        setErr(explainApiError(e));
      }).finally(() => setBusy(false));
    };
    if (password) run(password);
    else { setPending(() => run); setAsking(true); }
  };
  const next = () => setI((n) => Math.min(n + 1, steps.length - 1));
  const back = () => setI((n) => Math.max(n - 1, 0));
  const footer = (primary: ReactNode) => (
    <div className="flex items-center justify-between gap-2 border-t border-line pt-4">
      {i > 0 ? <Button type="button" variant="secondary" onClick={back}>{c.back}</Button> : <span />}
      {primary}
    </div>
  );
  const Step = step !== 'need' && step !== 'done' ? STEPS[step] : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={c.title} safaricom={c.safaricom} subtitle={c.intro} />
      <Card title={c.steps[step]} bodyClassName="space-y-4 p-4 md:p-6">
        <p className="text-sm text-muted">{copy.setup.stepOf(i + 1, steps.length)}</p>
        <ErrorCard error={err} />
        {step === 'need' && (
          <>
            <ol className="list-decimal space-y-2 pl-5 text-base">{c.need.map((s) => <li key={s}>{s}</li>)}</ol>
            <SafaricomHow links={[how.goLive, how.keys, how.operatorCreate]} />
            <p className="text-sm text-muted">{c.once}</p>
            {footer(<Button type="button" onClick={next}>{c.continueLabel}</Button>)}
          </>
        )}
        {Step && <Step key={step} prod={prod} live={live} busy={busy} footer={footer} next={next} back={back} withPassword={withPassword} reload={load} setErr={setErr} />}
        {step === 'done' && (
          <>
            <Flash tone="success"><p className="font-semibold">{c.done.title}</p><p>{c.done.body}</p></Flash>
            {footer(<Button type="button" onClick={() => nav('/')}>{c.done.home}</Button>)}
          </>
        )}
      </Card>
      <PasswordConfirmDialog open={asking} title={c.once} busy={busy} onCancel={() => { setAsking(false); setPending(null); }}
        onConfirm={(pw) => { setPassword(pw); setAsking(false); const p = pending; setPending(null); p?.(pw); }} />
    </div>
  );
}
