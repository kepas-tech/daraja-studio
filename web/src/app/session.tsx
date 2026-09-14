import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { Me, OrgSummary, Person, SetupSaved, SetupStatus } from '../api/types';

export type { Person };

type Status = 'loading' | 'needs-owner' | 'anonymous' | 'setup' | 'password-change' | 'ready' | 'error';
interface Session {
  status: Status;
  person: Person | null;
  org: OrgSummary | null;
  permissions: string[];
  setupStep: string | null;
  /** What the business said it needs, in its own words. `null` until it has been asked. */
  uses: { payOut: boolean; collect: boolean; stk: boolean } | null;
  /** Whether Safaricom has ever accepted a push here — the only proof a passkey can have. */
  passkeyProven: boolean;
  /** What earlier wizard steps stored, so Back shows the answer given. `null` before sign-in. */
  saved: SetupSaved | null;
  refresh: () => Promise<void>;
}

const empty = () => ({
  person: null, org: null, permissions: [] as string[],
  setupStep: null as string | null, uses: null as { payOut: boolean; collect: boolean; stk: boolean } | null, passkeyProven: false, saved: null as SetupSaved | null,
});
const Ctx = createContext<Session>({ status: 'loading', ...empty(), refresh: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<Omit<Session, 'refresh'>>({ status: 'loading', ...empty() });
  const refresh = useCallback(async () => {
    try {
      const st = await api.get<SetupStatus>('/api/setup/status');
      if (st.needsOwner) { setS({ status: 'needs-owner', ...empty() }); return; }
      try {
        const me = await api.get<Me>('/api/auth/me');
        api.setCsrf(me.csrf);
        const status: Status = me.person.must_change_password ? 'password-change' : (st.completed || !me.person.is_owner ? 'ready' : 'setup');
        setS({
          status, person: me.person, org: me.org ?? null, permissions: me.permissions,
          setupStep: st.step, uses: st.uses, passkeyProven: st.passkeyProven, saved: st.saved ?? null,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setS({ status: 'anonymous', ...empty(), setupStep: st.step });
        else throw e;
      }
    } catch {
      setS({ status: 'error', ...empty() });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <Ctx.Provider value={{ ...s, refresh }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);
