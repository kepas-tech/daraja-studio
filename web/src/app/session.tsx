import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { Confirm, Me, OrgSummary, Person, SetupSaved, SetupStatus } from '../api/types';

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
  /** Brief 2, item 3: a PIN is set, and this session is waiting for it. */
  pinSet: boolean;
  pinLocked: boolean;
  /** Opens the session with the PIN, or with the password when the PIN has been forgotten. */
  openSession: (confirm: Confirm) => Promise<void>;
  /** Locks now: the page went to the background, or went quiet for 30 minutes. */
  lock: () => Promise<void>;
  refresh: () => Promise<void>;
}

const empty = () => ({
  person: null, org: null, permissions: [] as string[],
  setupStep: null as string | null, uses: null as { payOut: boolean; collect: boolean; stk: boolean } | null, passkeyProven: false, saved: null as SetupSaved | null,
  pinSet: false, pinLocked: false,
});
const Ctx = createContext<Session>({ status: 'loading', ...empty(), openSession: async () => {}, lock: async () => {}, refresh: async () => {} });

/**
 * A login that just happened in this page: the password was typed seconds ago, so the PIN is not
 * asked for straight away. Module state on purpose — it dies with the page, and that is exactly the
 * line between a login and a browser reopened later on a phone that may no longer be the owner's.
 */
let justLoggedIn = false;
export function markJustLoggedIn() { justLoggedIn = true; }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<Omit<Session, 'refresh' | 'openSession' | 'lock'>>({ status: 'loading', ...empty() });
  /** Whether this page load has already applied the rule that a page load with a PIN starts locked. */
  const bootDone = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const st = await api.get<SetupStatus>('/api/setup/status');
      if (st.needsOwner) { setS({ status: 'needs-owner', ...empty() }); return; }
      try {
        const me = await api.get<Me>('/api/auth/me');
        api.setCsrf(me.csrf);
        const status: Status = me.person.must_change_password ? 'password-change' : (st.completed || !me.person.is_owner ? 'ready' : 'setup');
        // Brief 2, item 3. The first read of a page load locks the session when a PIN is set: a
        // browser reopened on a phone that is no longer the owner's is the case the lock is for.
        // Later refreshes only report what the server decided, so a page that is open stays open
        // while it is being used, and the PIN is never asked for again by an ordinary reload of a
        // page's data.
        const pin = me.pin ?? { set: false, locked: false };
        const lockNow = pin.set && (pin.locked || (!bootDone.current && !justLoggedIn));
        if (pin.set && !pin.locked && lockNow) void api.post('/api/auth/lock').catch(() => {});
        justLoggedIn = false;
        bootDone.current = true;
        setS({
          status, person: me.person, org: me.org ?? null, permissions: me.permissions,
          setupStep: st.step, uses: st.uses, passkeyProven: st.passkeyProven, saved: st.saved ?? null,
          pinSet: pin.set, pinLocked: lockNow,
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setS({ status: 'anonymous', ...empty(), setupStep: st.step });
        else throw e;
      }
    } catch {
      setS({ status: 'error', ...empty() });
    }
  }, []);
  const openSession = useCallback(async (confirm: Confirm) => {
    await api.post('/api/auth/open', confirm);
    setS((v) => ({ ...v, pinLocked: false }));
  }, []);
  const lock = useCallback(async () => {
    // The screen goes up first and the server is told second: if that call fails, the session is
    // still covered here, and the server's own idle rule locks it within PIN_IDLE_MINUTES anyway.
    setS((v) => (v.pinSet ? { ...v, pinLocked: true } : v));
    try { await api.post('/api/auth/lock'); } catch { /* already covered above */ }
  }, []);
  useEffect(() => {
    // Any refused-as-locked answer (a page open in another tab, a 30-minute-old session) raises the
    // same screen, wherever it came from.
    api.onLocked(() => setS((v) => (v.pinSet ? { ...v, pinLocked: true } : v)));
    return () => api.onLocked(null);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return <Ctx.Provider value={{ ...s, refresh, openSession, lock }}>{children}</Ctx.Provider>;
}
export const useSession = () => useContext(Ctx);
