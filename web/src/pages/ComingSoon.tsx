import { useLocation } from 'react-router';
import { copy } from '../copy/en';
import { PageHeader } from '../components/PageHeader';
export function ComingSoon() {
  const { pathname } = useLocation();
  const e = copy.nav.find((n) => n.path === pathname);
  return (<><PageHeader title={e?.label ?? copy.comingSoon.title} safaricom={e?.safaricom} /><p>{copy.comingSoon.body}</p></>);
}
