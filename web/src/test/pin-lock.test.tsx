import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { api } from '../api/client';
import { SessionProvider } from '../app/session';
import { Layout } from '../app/Layout';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { PinCard } from '../pages/settings/PinCard';
import { useStepUp, type StepUp } from '../pages/settings/useStepUp';
import { copy } from '../copy/en';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
beforeEach(() => { localStorage.clear(); });

// The suite runs a dozen files at once, so the default one-second wait is a flake waiting to
// happen on a loaded machine. Everything here that waits gets room.
const SLOW = { timeout: 5000 };
const waitForSlow = (fn: () => unknown) => waitFor(fn, SLOW);
// The test below boots the app twice, so its own budget has to clear both waits in it. Without
// this the default five seconds is the same as one SLOW wait, and a loaded machine times it out.
const TWO_BOOTS = 20_000;
const openTheLock = () => screen.findByTestId('lock-screen', {}, SLOW);
const signedIn = () => screen.findByRole('button', { name: copy.account.menu }, SLOW);
const dots = () => Number(screen.getByTestId('pin-dots').dataset.filled);
/** Type the six digits the way a thumb does: one key at a time. */
const typePin = (pin: string) => { for (const d of pin) fireEvent.click(screen.getByRole('button', { name: d })); };

const OWNER = { id: '1', username: 'owner', display_name: 'Owner', is_owner: true, must_change_password: false };
const PIN = '246813';
const PASSWORD = 'correct horse';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Wire { url: string; body: unknown }

/** A browser with a fingerprint reader, and a credential that answers it. */
function stubPlatformAuthenticator(available = true) {
  const assertion = {
    id: 'cred-1',
    rawId: new Uint8Array([1, 2, 3]).buffer,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
      userHandle: null,
    },
  };
  const attestation = { ...assertion, response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([4]).buffer } };
  const get = vi.fn(async () => assertion);
  const create = vi.fn(async () => attestation);
  const PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => available,
  });
  vi.stubGlobal('PublicKeyCredential', PublicKeyCredential);
  Object.defineProperty(navigator, 'credentials', { value: { get, create }, configurable: true });
  return { get, create };
}

/** The answers the lock screen needs, plus a record of everything posted. */
function boot(opts: { pin?: { set: boolean; locked: boolean; bio?: boolean }; open?: () => Response; posts?: Wire[] } = {}) {
  const posts: Wire[] = opts.posts ?? [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Record first, answer second: a ceremony's options call is as much a part of the flow as its
    // verify, and the tests count both.
    if (init?.method && init.method !== 'GET') posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/setup/status') return json({ needsOwner: false, completed: true, step: null });
    if (url === '/api/auth/me') return json({ person: OWNER, csrf: 'c', permissions: [], pin: opts.pin ?? { set: false, locked: false, bio: false } });
    if (url === '/api/auth/webauthn/register/options') {
      // Real base64url challenges, of the shape the server generates: a made-up string like
      // 'chal-reg' is not decodable, and the browser half has to decode it.
      return json({ challenge: 'Y2hhbGxlbmdlLXJlZw', rp: { id: 'studio.test', name: 'x' }, user: { id: 'dXNlci0x', name: 'owner', displayName: 'Owner' }, pubKeyCredParams: [] });
    }
    if (url === '/api/auth/webauthn/open/options') {
      return json({ challenge: 'Y2hhbGxlbmdlLW9wZW4', rpId: 'studio.test', allowCredentials: [{ id: 'Y3JlZC0x', type: 'public-key' }] });
    }
    if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'DELETE') {
      if (url === '/api/auth/open' && opts.open) return opts.open();
      return new Response(null, { status: url === '/api/send/phone' ? 201 : 204 });
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, posts };
}

const app = () => render(<MemoryRouter><SessionProvider><Layout /></SessionProvider></MemoryRouter>);

describe('the lock screen, as the owner asked for it', () => {
  it('fills a dot per digit and submits on the sixth, with no confirm button', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    // Item 6: the brand block is the full logo — no letter square, no separate name line.
    expect(screen.getByAltText(copy.appName)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.lock.continueLabel })).toBeNull();
    for (const d of '24681') fireEvent.click(screen.getByRole('button', { name: d }));
    expect(dots()).toBe(5);
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitForSlow(() => expect(posts).toEqual([{ url: '/api/auth/open', body: { pin: PIN } }]));
    await signedIn();
  });

  it('clears the dots and says "Wrong PIN." when the PIN is refused', async () => {
    boot({ pin: { set: true, locked: true }, open: () => json({ error: { code: 'pin_wrong', message: 'That PIN is wrong.' } }, 403) });
    app();
    await openTheLock();
    typePin(PIN);
    await waitForSlow(() => expect(screen.getByTestId('pin-message')).toHaveTextContent(copy.lock.wrongPin));
    // The dots are cleared by the same refusal, one render later.
    await waitForSlow(() => expect(dots()).toBe(0));
    expect(screen.getByTestId('lock-screen')).toBeInTheDocument();
  });

  it('says how long a locked PIN has left, from a 423 or a 429', async () => {
    boot({ pin: { set: true, locked: true }, open: () => json({ error: { code: 'pin_locked', message: 'Too many wrong tries.', details: { retryAfterSec: 900 } } }, 423) });
    app();
    await openTheLock();
    typePin(PIN);
    await waitForSlow(() => expect(screen.getByTestId('pin-message')).toHaveTextContent('Locked. Try again in 15 min.'));
    cleanup();

    boot({ pin: { set: true, locked: true }, open: () => json({ error: { code: 'too_many', message: 'Slow down.', details: { retryAfterSec: 120 } } }, 429) });
    app();
    await openTheLock();
    typePin(PIN);
    await waitForSlow(() => expect(screen.getByTestId('pin-message')).toHaveTextContent('Locked. Try again in 2 min.'));
  });

  it('keeps "Use your password instead" one tap away, both ways', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.usePassword }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.usePin }));
    expect(screen.getByTestId('pin-dots')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('offers the fingerprint only with a credential, and tries it exactly once on load', async () => {
    stubPlatformAuthenticator(true);
    const { posts } = boot({ pin: { set: true, locked: true, bio: true } });
    app();
    await openTheLock();
    await signedIn();
    const opened = posts.map((p) => p.url);
    expect(opened.filter((u) => u === '/api/auth/webauthn/open/options')).toHaveLength(1);
    expect(opened).toContain('/api/auth/webauthn/open/verify');
    expect(opened).not.toContain('/api/auth/open');
    cleanup();

    // No credential: no ceremony, no fingerprint key, and the PIN keypad is simply there.
    boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    expect(screen.queryByRole('button', { name: copy.lock.fingerprint })).toBeNull();
  });

  it('falls back to the PIN in silence when the fingerprint is refused, and the key retries', async () => {
    const { get } = stubPlatformAuthenticator(true);
    get.mockRejectedValueOnce(new Error('NotAllowedError'));
    const { posts } = boot({ pin: { set: true, locked: true, bio: true } });
    app();
    await openTheLock();
    await waitForSlow(() => expect(screen.getByTestId('pin-message')).toHaveTextContent(copy.lock.enterPin));
    fireEvent.click(screen.getByRole('button', { name: copy.lock.fingerprint }));
    await signedIn();
    expect(posts.map((p) => p.url)).toEqual(['/api/auth/webauthn/open/options', '/api/auth/webauthn/open/options', '/api/auth/webauthn/open/verify']);
  });

  it('locks on a page load the server still had open, and when the page goes to the background', async () => {
    const { posts } = boot({ pin: { set: true, locked: false } });
    app();
    await openTheLock();
    await waitForSlow(() => expect(posts.map((p) => p.url)).toEqual(['/api/auth/lock']));

    typePin(PIN);
    await signedIn();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await openTheLock();
    await waitForSlow(() => expect(posts.map((p) => p.url)).toEqual(['/api/auth/lock', '/api/auth/open', '/api/auth/lock']));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('signs out from the lock screen', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    fireEvent.click(screen.getByRole('button', { name: copy.lock.signOut }));
    await waitForSlow(() => expect(posts.map((p) => p.url)).toContain('/api/auth/logout'));
  });
});

describe('the fingerprint card and the Organisation list', () => {
  it('asks once after a PIN open, and remembers Not now', async () => {
    stubPlatformAuthenticator(true);
    boot({ pin: { set: true, locked: true, bio: false } });
    app();
    await openTheLock();
    typePin(PIN);
    await signedIn();
    const card = await screen.findByTestId('bio-card', {}, SLOW);
    expect(card).toHaveTextContent(copy.bio.ask);
    // The one fingerprint icon, item 6: the card that offers it carries it too.
    expect(within(card).getByTestId('fingerprint-icon')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.bio.notNow }));
    expect(screen.queryByTestId('bio-card')).toBeNull();
    expect(localStorage.getItem('studio.bio.dismissed')).toBe('1');
    cleanup();

    // A second visit asks nothing: the answer was remembered on this device.
    boot({ pin: { set: true, locked: true, bio: false } });
    app();
    await openTheLock();
    typePin(PIN);
    await signedIn();
    await waitForSlow(() => expect(screen.queryByTestId('bio-card')).toBeNull());
  }, TWO_BOOTS);

  it('turns the fingerprint on from the card', async () => {
    const { create } = stubPlatformAuthenticator(true);
    const { posts } = boot({ pin: { set: true, locked: true, bio: false } });
    app();
    await openTheLock();
    typePin(PIN);
    await screen.findByTestId('bio-card', {}, SLOW);
    fireEvent.click(screen.getByRole('button', { name: copy.bio.turnOn }));
    await waitForSlow(() => expect(posts.map((p) => p.url)).toContain('/api/auth/webauthn/register/verify'));
    expect(create).toHaveBeenCalled();
    expect(screen.queryByTestId('bio-card')).toBeNull();
  });

  it('lists the devices under Organisation and removes one behind the step-up', async () => {
    const posts: Wire[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/setup/status') return json({ needsOwner: false, completed: true, step: null });
      if (url === '/api/auth/me') return json({ person: OWNER, csrf: 'c', permissions: [], pin: { set: true, locked: false, bio: true } });
      if (url === '/api/auth/webauthn/credentials') return json({ items: [{ id: 'cred-1', label: 'iPhone', createdAt: '2026-09-17T09:00:00Z', lastUsedAt: null }] });
      if (init?.method === 'POST') { posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null }); return new Response(null, { status: 204 }); }
      throw new Error('unexpected fetch ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const stepUp: StepUp = {
      ask: (_title, run) => { void run({ password: PASSWORD }); },
      dialogProps: { open: false, title: '', busy: false, error: null, pin: true, onConfirm: () => {}, onCancel: () => {} },
    };
    render(<SessionProvider><PinCard stepUp={stepUp} /></SessionProvider>);
    const row = await screen.findByTestId('bio-device', {}, SLOW);
    expect(within(row).getByTestId('fingerprint-icon')).toBeInTheDocument();
    expect(row).toHaveTextContent('iPhone');
    expect(row).toHaveTextContent(copy.bio.never);
    fireEvent.click(screen.getByRole('button', { name: copy.bio.remove }));
    await waitForSlow(() => expect(posts).toContainEqual({ url: '/api/auth/webauthn/credentials/remove', body: { id: 'cred-1', password: PASSWORD } }));
  });
});

describe('the money keypad', () => {
  it('asks for the PIN on a money action and sends it as a PIN, and Cancel sends nothing', async () => {
    const { posts } = boot({ pin: { set: true, locked: true, bio: false } });
    function StepUpPage() {
      const stepUp = useStepUp();
      return (
        <>
          <button type="button" onClick={() => stepUp.ask('Send KES 500?', async (confirm) => {
            await api.post('/api/send/phone', { phone: '254712345678', ...confirm });
          })}>send</button>
          <PasswordConfirmDialog {...stepUp.dialogProps} />
        </>
      );
    }
    render(
      <MemoryRouter>
        <SessionProvider>
          <Routes><Route element={<Layout />}><Route path="/" element={<StepUpPage />} /></Route></Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
    await openTheLock();
    typePin(PIN);
    await signedIn();
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(screen.getByText(copy.confirm.pinSub)).toBeInTheDocument();
    // The money sheet carries the same logo, small enough to keep the keys on a phone.
    expect(screen.getByAltText(copy.appName)).toBeInTheDocument();

    // Cancel is the bottom-left key: the dialog closes and nothing was sent.
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.cancel }));
    await waitForSlow(() => expect(screen.queryByText(copy.confirm.pinSub)).toBeNull());
    expect(posts.map((p) => p.url)).not.toContain('/api/send/phone');

    // The whole point: six digits, no long password on a phone.
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    typePin(PIN);
    await waitForSlow(() => expect(posts.at(-1)).toEqual({ url: '/api/send/phone', body: { phone: '254712345678', pin: PIN } }));
  });

  it('sets the PIN from Organisation with the password, and removes it the same way', async () => {
    const stepUp: StepUp = {
      ask: (_title, run) => { void run({ password: PASSWORD }); },
      dialogProps: { open: false, title: '', busy: false, error: null, pin: false, onConfirm: () => {}, onCancel: () => {} },
    };
    const first = boot({ pin: { set: false, locked: false } });
    render(<SessionProvider><PinCard stepUp={stepUp} /></SessionProvider>);
    fireEvent.change(screen.getByLabelText(copy.account.pin.newPin), { target: { value: PIN } });
    fireEvent.change(screen.getByLabelText(copy.account.pin.repeat), { target: { value: PIN } });
    fireEvent.click(screen.getByRole('button', { name: copy.account.pin.set }));
    await waitForSlow(() => expect(first.posts).toEqual([{ url: '/api/auth/pin', body: { newPin: PIN, password: PASSWORD } }]));
    cleanup();

    const second = boot({ pin: { set: true, locked: false, bio: false } });
    render(<SessionProvider><PinCard stepUp={stepUp} /></SessionProvider>);
    fireEvent.click(await screen.findByRole('button', { name: copy.account.pin.remove }, SLOW));
    await waitForSlow(() => expect(second.posts).toContainEqual({ url: '/api/auth/pin', body: { password: PASSWORD } }));
  });
});
