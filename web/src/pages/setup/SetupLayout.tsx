import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useSession } from '../../app/session';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { ToastHost } from '../../components/Toast';
import { copy } from '../../copy/en';
import { Owner } from './Owner';
import { Uses } from './Uses';
import { Org } from './Org';
import { Environment } from './Environment';
import { Shortcode } from './Shortcode';
import { Daraja } from './Daraja';
import { Passkey } from './Passkey';
import { PublicUrl } from './PublicUrl';
import { Operator } from './Operator';
import { Done } from './Done';
import logo from '../../assets/logo-long.png';

const ORDER = ['owner', 'uses', 'environment', 'org', 'shortcode', 'daraja', 'public-url', 'passkey', 'operator', 'done'];

export function SetupLayout() {
  const s = useSession(); const nav = useNavigate(); const { pathname } = useLocation();
  const fromSession = s.status === 'needs-owner' ? 'owner' : (s.setupStep ?? 'uses');
  // The URL is the truth for what is on screen: a step page navigates onward without a session
  // refresh, so the session's own step can lag one behind.
  const fromUrl = pathname.split('/setup/')[1]?.split('/')[0] ?? '';
  const current = ORDER.includes(fromUrl) ? fromUrl : fromSession;
  const go = (step: string) => nav(`/setup/${step}`);
  // The passkey can only be tested once the public address is reachable — the push needs a real
  // callback address to answer — and a business that never collects has no use for one; a business
  // that never pays out has no use for an operator. The step list, the counter and both
  // destinations skip whichever the owner's own answers to "What you need" ruled out.
  const steps = ORDER.filter((k) => (k !== 'passkey' || s.uses?.collect !== false) && (k !== 'operator' || s.uses?.payOut !== false));
  const idx = Math.max(0, steps.indexOf(current));
  const titleOf = (k: string) => copy.setup.steps[ORDER.indexOf(k)];
  const afterPublicUrl = () => go(s.uses?.collect ? 'passkey' : s.uses?.payOut ? 'operator' : 'done');
  const afterPasskey = () => go(s.uses?.payOut ? 'operator' : 'done');
  return (
    <div className="min-h-screen bg-page px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <img src={logo} alt={copy.appName} className="mx-auto h-12 w-auto" />
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-2xl font-semibold">{copy.setup.title}</h1>
            <span className="text-sm text-muted">{copy.setup.stepOf(idx + 1, steps.length)}</span>
          </div>
          <div role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={idx + 1} className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div className="h-full bg-brand transition-all" style={{ width: `${((idx + 1) / steps.length) * 100}%` }} />
          </div>
        </div>
        <ol className="hidden flex-wrap gap-x-4 gap-y-1 text-sm md:flex">
          {steps.map((k, i) => (
            <li key={k} className={`flex items-center gap-1 ${i < idx ? 'text-brand-dark' : i === idx ? 'font-semibold text-ink' : 'text-muted'}`}>
              {i < idx ? <Icon name="confirm" className="size-4" /> : <span>{i + 1}.</span>}{titleOf(k)}
            </li>
          ))}
        </ol>
        <Card title={titleOf(current)} bodyClassName="space-y-4 p-4 md:p-6">
          <p className="text-base text-muted">{copy.setup.intro[current]}</p>
          <Routes>
            <Route index element={<Navigate to={`/setup/${fromSession}`} replace />} />
            <Route path="owner" element={<Owner onDone={async () => { await s.refresh(); go('uses'); }} />} />
            <Route path="uses" element={<Uses onDone={async () => { await s.refresh(); go('environment'); }} />} />
            <Route path="environment" element={<Environment onDone={() => go('org')} />} />
            <Route path="org" element={<Org onDone={() => go('shortcode')} onBack={() => go('environment')} />} />
            <Route path="shortcode" element={<Shortcode onDone={() => go('daraja')} onBack={() => go('org')} />} />
            <Route path="daraja" element={<Daraja onDone={() => go('public-url')} onBack={() => go('shortcode')} />} />
            <Route path="public-url" element={<PublicUrl onDone={afterPublicUrl} onBack={() => go('daraja')} />} />
            <Route path="passkey" element={<Passkey onDone={async () => { await s.refresh(); afterPasskey(); }} onBack={() => go('public-url')} />} />
            <Route path="operator" element={<Operator onDone={() => go('done')} onBack={() => go(s.uses?.collect ? 'passkey' : 'public-url')} />} />
            <Route path="done" element={<Done onDone={async () => { await s.refresh(); nav('/'); }} />} />
          </Routes>
        </Card>
        <ToastHost />
      </div>
    </div>
  );
}
