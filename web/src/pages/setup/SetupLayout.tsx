import { Navigate, Route, Routes, useNavigate } from 'react-router';
import { useSession } from '../../app/session';
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

const ORDER = ['owner', 'uses', 'environment', 'org', 'shortcode', 'daraja', 'public-url', 'passkey', 'operator', 'done'];

export function SetupLayout() {
  const s = useSession(); const nav = useNavigate();
  const current = s.status === 'needs-owner' ? 'owner' : (s.setupStep ?? 'uses');
  const go = (step: string) => nav(`/setup/${step}`);
  const idx = ORDER.indexOf(current);
  // The passkey can only be tested once the public address is reachable — the push needs a real
  // callback address to answer — and a business that never collects has no use for one; a business
  // that never pays out has no use for an operator. Both destinations skip whichever the owner's
  // own answers to "What you need" said this shortcode has no use for.
  const afterPublicUrl = () => go(s.uses?.collect ? 'passkey' : s.uses?.payOut ? 'operator' : 'done');
  const afterPasskey = () => go(s.uses?.payOut ? 'operator' : 'done');
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-2 text-2xl font-semibold">{copy.setup.title}</h1>
      <ol className="mb-8 flex flex-wrap gap-2 text-sm">{copy.setup.steps.map((t, i) => <li key={t} className={`rounded-full border px-3 py-1 ${i <= idx ? 'border-[#186738] text-[#186738]' : 'border-[#cccccc] text-black dark:text-white'}`}>{i + 1}. {t}</li>)}</ol>
      <Routes>
        <Route index element={<Navigate to={`/setup/${current}`} replace />} />
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
      <ToastHost />
    </div>
  );
}
