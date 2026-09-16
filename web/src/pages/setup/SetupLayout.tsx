import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useSession } from '../../app/session';
import { Card } from '../../components/Card';
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

const ORDER = ['owner', 'environment', 'uses', 'org', 'shortcode', 'daraja', 'public-url', 'passkey', 'operator', 'done'];

export function SetupLayout() {
  const s = useSession(); const nav = useNavigate(); const { pathname } = useLocation();
  const fromSession = s.status === 'needs-owner' ? 'owner' : (s.setupStep ?? 'environment');
  // The URL is the truth for what is on screen: a step page navigates onward without a session
  // refresh, so the session's own step can lag one behind.
  const fromUrl = pathname.split('/setup/')[1]?.split('/')[0] ?? '';
  const current = ORDER.includes(fromUrl) ? fromUrl : fromSession;
  // Every step stores its answer on the server before moving on; refreshing here is what lets
  // Back (and a reload) show the answer instead of a blank field.
  const go = async (step: string) => { await s.refresh(); nav(`/setup/${step}`); };
  // The passkey can only be tested once the public address is reachable — the push needs a real
  // callback address to answer — and only the phone prompt (STK Push) needs one; only paying out
  // needs an operator. The step list, the counter and both destinations skip whichever the
  // owner's own answers to "What you need" ruled out.
  const steps = ORDER.filter((k) => (k !== 'passkey' || s.uses?.stk !== false) && (k !== 'operator' || s.uses?.payOut !== false));
  const idx = Math.max(0, steps.indexOf(current));
  const titleOf = (k: string) => copy.setup.steps[ORDER.indexOf(k)];
  const afterPublicUrl = () => go(s.uses?.stk ? 'passkey' : s.uses?.payOut ? 'operator' : 'done');
  const afterPasskey = () => go(s.uses?.payOut ? 'operator' : 'done');
  return (
    <div className="min-h-screen bg-page px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <img src={logo} alt={copy.appName} className="mx-auto h-20 w-auto" />
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-2xl font-semibold">{copy.setup.title}</h1>
            <span className="text-sm text-muted">{copy.setup.stepOf(idx + 1, steps.length)}</span>
          </div>
          <div role="progressbar" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={idx + 1} className="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div className="h-full bg-brand transition-all" style={{ width: `${((idx + 1) / steps.length) * 100}%` }} />
          </div>
        </div>
        <Card title={titleOf(current)} bodyClassName="space-y-4 p-4 md:p-6">
          <p className="text-base text-muted">{copy.setup.intro[current]}</p>
          <Routes>
            <Route index element={<Navigate to={`/setup/${fromSession}`} replace />} />
            <Route path="owner" element={<Owner created={s.person?.display_name ?? null} onDone={async () => { if (!s.person) await s.refresh(); go('environment'); }} />} />
            <Route path="environment" element={<Environment onDone={() => go('uses')} onBack={() => go('owner')} />} />
            <Route path="uses" element={<Uses onDone={() => go('org')} onBack={() => go('environment')} />} />
            <Route path="org" element={<Org onDone={() => go('shortcode')} onBack={() => go('uses')} />} />
            <Route path="shortcode" element={<Shortcode onDone={() => go('daraja')} onBack={() => go('org')} />} />
            <Route path="daraja" element={<Daraja onDone={() => go('public-url')} onBack={() => go('shortcode')} />} />
            <Route path="public-url" element={<PublicUrl onDone={afterPublicUrl} onBack={() => go('daraja')} />} />
            <Route path="passkey" element={<Passkey onDone={afterPasskey} onBack={() => go('public-url')} />} />
            <Route path="operator" element={<Operator onDone={() => go('done')} onBack={() => go(s.uses?.stk ? 'passkey' : 'public-url')} />} />
            <Route path="done" element={<Done onDone={async () => { await s.refresh(); nav('/'); }} />} />
          </Routes>
        </Card>
        <p className="text-center text-sm"><Link to="/guide">{copy.login.guideLink}</Link></p>
        <ToastHost />
      </div>
    </div>
  );
}
