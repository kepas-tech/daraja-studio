import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { SessionProvider, useSession } from './session';
import { Layout } from './Layout';
import { copy } from '../copy/en';
import { Button } from '../components/Button';
import { ComingSoon } from '../pages/ComingSoon';
import { Login } from '../pages/Login';
import { Home } from '../pages/Home';
import { Settings } from '../pages/Settings';
import { NotPossible } from '../pages/NotPossible';
import { SetupLayout } from '../pages/setup/SetupLayout';
import { SendHub } from '../pages/send/SendHub';
import { SendPhone } from '../pages/send/SendPhone';
import { Balances } from '../pages/Balances';
import { Lookup } from '../pages/Lookup';
import { History } from '../pages/History';
import { RequestDetail } from '../pages/RequestDetail';
import { People } from '../pages/People';
import { ChangePassword } from '../pages/ChangePassword';
import { Qr } from '../pages/Qr';
import { AskToPay } from '../pages/AskToPay';
import { Reverse } from '../pages/Reverse';

function Gate() {
  const s = useSession();
  if (s.status === 'loading') return <p className="p-6">{copy.app.loading}</p>;
  if (s.status === 'error') {
    return (
      <div className="mx-auto mt-24 max-w-sm space-y-4 rounded-xl bg-white p-6 text-center shadow dark:bg-gray-900">
        <h1 className="text-xl font-semibold">{copy.app.errorTitle}</h1>
        <p className="text-sm text-gray-600">{copy.app.errorBody}</p>
        <Button onClick={() => void s.refresh()}>{copy.app.retry}</Button>
      </div>
    );
  }
  if (s.status === 'password-change') return <ChangePassword />;
  if (s.status === 'needs-owner' || s.status === 'setup') return <Routes><Route path="/setup/*" element={<SetupLayout />} /><Route path="*" element={<Navigate to="/setup" replace />} /></Routes>;
  if (s.status === 'anonymous') {
    return <Routes><Route path="/login" element={<Login />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes>;
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/people" element={<People />} />
        <Route path="/not-possible" element={<NotPossible />} />
        <Route path="/send" element={<SendHub />} />
        <Route path="/send/phone" element={<SendPhone />} />
        <Route path="/balances" element={<Balances />} />
        <Route path="/lookup" element={<Lookup />} />
        <Route path="/qr" element={<Qr />} />
        <Route path="/ask-to-pay" element={<AskToPay />} />
        <Route path="/reverse" element={<Reverse />} />
        <Route path="/history" element={<History />} />
        <Route path="/requests/:id" element={<RequestDetail />} />
        {copy.nav.filter((e) => !e.available).map((e) => <Route key={e.key} path={e.path} element={<ComingSoon />} />)}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
export function AppRouter() { return <BrowserRouter><SessionProvider><Gate /></SessionProvider></BrowserRouter>; }
