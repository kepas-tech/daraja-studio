import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { Confirm, Me, OrgSummary, Person, SetupSaved, SetupStatus } from '../api/types';
import { openWithFingerprint as openWebauthn, platformAvailable, registerFingerprint as registerWebauthn } from './webauthn';

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
  /** Step two: the paybill question's answer, and where "no" sends people. */
  paybill: 'own' | 'none' | null;
  signupUrl: string | null;
  /** What earlier wizard steps stored, so Back shows the answer given. `null` before sign-in. */
  saved: SetupSaved | null;
  /** Brief 2, item 3: a PIN is set, and this session is waiting for it. */
  pinSet: boolean;
  pinLocked: boolean;
  /** Brief 2, item 5b: this person has a fingerprint enrolled, so the lock screen offers it. */
  pinBio: boolean;
  /** Step one: what this studio has switched off — the modules, and the menu entries they hide. */
  modules: { off: string[]; menuOff: string[]; /** The tier the switched-on parts equal, or null. */ tier: string | null };
  /** Opens the session with the PIN, or with the password when the PIN has been forgotten. */
  openSession: (confirm: Confirm) => Promise<void>;
  /** Opens it with the fingerprint instead. False means the lock screen falls back to the PIN. */
  openWithFingerprint: () => Promise<boolean>;
  /** Enrols this device. Needs an open session; the server refuses the ceremony while locked. */
  registerFingerprint: () => Promise<boolean>;
  /** The one card that asks, once per device, after a PIN opens a device with no credential. */
  bioPrompt: boolean;
  dismissBioPrompt: () => void;
  /** Locks now: the page went to the background, or went quiet for 30 minutes. */
  lock: () => Promise<void>;
  refresh: () => Promise<void>;
}

const empty = () => ({
  person: null, org: null, permissions: [] as string[],
  setupStep: null as string | null, uses: null as { payOut: boolean; collect: boolean; stk: boolean } | null, passkeyProven: false,
  paybill: null as 'own' | 'none' | null, signupUrl: null as string | null, saved: null as SetupSaved | null,
  pinSet: false, pinLocked: false, pinBio: false,
  modules: { off: [] as string[], menuOff: [] as string[], tier: null as string | null },
});
const noop = async () => {};
const noopFalse = async () => false;
const Ctx = createContext<Session>({
  status: 'loading', ...empty(),
  openSession: noop, openWithFingerprint: noopFalse, registerFingerprint: noopFalse,
  bioPrompt: false, dismissBioPrompt: () => {}, lock: noop, refresh: noop,
});

/** "Not now" on the fingerprint card is remembered per device, which for a browser is this storage. */
const BIO_DISMISSED = 'studio.bio.dismissed';
function bioDismissed(): boolean {
  try { return localStorage.getItem(BIO_DISMISSED) === '1'; } catch { return false; }
}

/**
 * A login that just happened in this page: the password was typed seconds ago, so the PIN is not
 * asked for straight away. Module state on purpose — it dies with the page, and that is exactly the
 * line between a login and a browser reopened later on a phone that may no longer be the owner's.
 */
let justLoggedIn = false;
export function markJustLoggedIn() { justLoggedIn = true; }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<Omit<Session, 'refresh' | 'openSession' | 'openWithFingerprint' | 'registerFingerprint' | 'bioPrompt' | 'dismissBioPrompt' | 'lock'>>({ status: 'loading', ...empty() });
  const [bioPrompt, setBioPrompt] = useState(false);
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
        const pin = me.pin ?? { set: false, locked: false, bio: false };
        const lockNow = pin.set && (pin.locked || (!bootDone.current && !justLoggedIn));
        if (pin.set && !pin.locked && lockNow) void api.post('/api/auth/lock').catch(() => {});
        justLoggedIn = false;
        bootDone.current = true;
        setS({
          status, person: me.person, org: me.org ?? null, permissions: me.permissions,
          setupStep: st.step, uses: st.uses, passkeyProven: st.passkeyProven, saved: st.saved ?? null,
          paybill: st.paybill ?? null, signupUrl: st.signupUrl ?? null,
          pinSet: pin.set, pinLocked: lockNow, pinBio: pin.bio === true,
          modules: {
            off: me.modules?.off ?? [], menuOff: me.modules?.menuOff ?? [],
            // Absent from an older server reads as "no tier known", and the tag says so plainly.
            tier: me.modules?.tier ?? null,
          },
        });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setS({ status: 'anonymous', ...empty(), setupStep: st.step });
        else throw e;
      }
    } catch {
      setS({ status: 'error', ...empty() });
    }
  }, []);
  /** After a PIN opened the session: offer the fingerprint once, on a device that has none. */
  const maybeAskForFingerprint = useCallback(async () => {
    if (bioDismissed()) return;
    if (!(await platformAvailable())) return;
    setBioPrompt(true);
  }, []);
  const openSession = useCallback(async (confirm: Confirm) => {
    await api.post('/api/auth/open', confirm);
    setS((v) => ({ ...v, pinLocked: false }));
    if ('pin' in confirm) void maybeAskForFingerprint();
  }, [maybeAskForFingerprint]);
  const openWithFingerprint = useCallback(async () => {
    const ok = await openWebauthn();
    if (ok) setS((v) => ({ ...v, pinLocked: false }));
    return ok;
  }, []);
  const registerFingerprint = useCallback(async () => {
    const ok = await registerWebauthn();
    if (ok) { setBioPrompt(false); setS((v) => ({ ...v, pinBio: true })); }
    return ok;
  }, []);
  const dismissBioPrompt = useCallback(() => {
    try { localStorage.setItem(BIO_DISMISSED, '1'); } catch { /* private mode: it will ask once more */ }
    setBioPrompt(false);
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
  return (
    <Ctx.Provider value={{ ...s, bioPrompt, refresh, openSession, openWithFingerprint, registerFingerprint, dismissBioPrompt, lock }}>
      {children}
    </Ctx.Provider>
  );
}
export const useSession = () => useContext(Ctx);
