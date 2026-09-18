import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { SessionProvider, useSession } from './session';
import { Layout } from './Layout';
import { copy } from '../copy/en';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Loading } from '../components/Loading';
import { ComingSoon } from '../pages/ComingSoon';
import { Login } from '../pages/Login';
import { Home } from '../pages/Home';
import { Settings } from '../pages/Settings';
import { NotPossible } from '../pages/NotPossible';
import { SetupLayout } from '../pages/setup/SetupLayout';
import { SendHub } from '../pages/send/SendHub';
import { SendPhone } from '../pages/send/SendPhone';
import { History } from '../pages/History';
import { Reports } from '../pages/Reports';
import { RequestDetail } from '../pages/RequestDetail';
import { People } from '../pages/People';
import { Contacts } from '../pages/Contacts';
import { AccountStatement } from '../pages/AccountStatement';
import { Reconcile } from '../pages/Reconcile';
import { Businesses } from '../pages/Businesses';
import { WhoDidWhat } from '../pages/WhoDidWhat';
import { Notifications } from '../pages/Notifications';
import { ChangePassword } from '../pages/ChangePassword';
import { Qr } from '../pages/Qr';
import { AskToPay } from '../pages/AskToPay';
import { Reverse } from '../pages/Reverse';
import { Account } from '../pages/Account';
import { MoneyIn } from '../pages/MoneyIn';
import { Approvals } from '../pages/Approvals';
import { Bulk, BulkDetail } from '../pages/Bulk';
import { Invoices, InvoiceDetail } from '../pages/Invoices';
import { StandingOrders } from '../pages/collect/StandingOrders';
import { Express } from '../pages/collect/Express';
import { Bonga } from '../pages/collect/Bonga';
import { Advanced } from '../pages/Advanced';
import { Guide } from '../pages/Guide';
import { GoLive } from '../pages/GoLive';

function Gate() {
  const s = useSession();
  if (s.status === 'loading') return <Loading full />;
  if (s.status === 'error') {
    return (
      <div className="mx-auto mt-24 max-w-sm px-4">
        <Card title={copy.app.errorTitle} bodyClassName="space-y-4 p-4 text-center">
          <p className="text-sm text-muted">{copy.app.errorBody}</p>
          <Button onClick={() => void s.refresh()}>{copy.app.retry}</Button>
        </Card>
      </div>
    );
  }
  if (s.status === 'password-change') return <ChangePassword />;
  if (s.status === 'needs-owner' || s.status === 'setup') return <Routes><Route path="/setup/*" element={<SetupLayout />} /><Route path="/guide" element={<Guide standalone />} /><Route path="*" element={<Navigate to="/setup" replace />} /></Routes>;
  if (s.status === 'anonymous') {
    return <Routes><Route path="/login" element={<Login />} /><Route path="/guide" element={<Guide standalone />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes>;
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/account" element={<Account />} />
        <Route path="/account/password" element={<VoluntaryPasswordChange />} />
        <Route path="/go-live" element={<GoLive />} />
        <Route path="/people" element={<People />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/businesses" element={<Businesses />} />
        <Route path="/accounts/:id" element={<AccountStatement />} />
        <Route path="/reconcile" element={<Reconcile />} />
        <Route path="/who-did-what" element={<WhoDidWhat />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/not-possible" element={<NotPossible />} />
        <Route path="/send" element={<SendHub />} />
        <Route path="/send/phone" element={<SendPhone />} />
        <Route path="/balances" element={<Navigate to="/" replace />} />
        <Route path="/lookup" element={<Navigate to="/history" replace />} />
        <Route path="/qr" element={<Qr />} />
        <Route path="/ask-to-pay" element={<AskToPay />} />
        <Route path="/reverse" element={<Reverse />} />
        <Route path="/money-in" element={<MoneyIn />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/bulk" element={<Bulk />} />
        <Route path="/bulk/:id" element={<BulkDetail />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/invoices/:id" element={<InvoiceDetail />} />
        <Route path="/standing-orders" element={<StandingOrders />} />
        <Route path="/express" element={<Express />} />
        <Route path="/bonga" element={<Bonga />} />
        <Route path="/advanced" element={<Advanced />} />
        <Route path="/guide" element={<Guide />} />
        <Route path="/history" element={<History />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/requests/:id" element={<RequestDetail />} />
        {copy.nav.filter((e) => !e.available).map((e) => <Route key={e.key} path={e.path} element={<ComingSoon />} />)}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
function VoluntaryPasswordChange() {
  const nav = useNavigate();
  return <ChangePassword voluntary onDone={() => nav('/account')} />;
}

export function AppRouter() { return <BrowserRouter><SessionProvider><Gate /></SessionProvider></BrowserRouter>; }
