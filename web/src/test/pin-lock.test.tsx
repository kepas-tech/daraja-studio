import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../api/client';
import { SessionProvider } from '../app/session';
import { Layout } from '../app/Layout';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { PinCard } from '../pages/settings/PinCard';
import { useStepUp, type StepUp } from '../pages/settings/useStepUp';
import { copy } from '../copy/en';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const OWNER = { id: '1', username: 'owner', display_name: 'Owner', is_owner: true, must_change_password: false };
const PIN = '246813';
const PASSWORD = 'correct horse';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Wire { url: string; body: unknown }

/** The four answers the lock needs, plus a record of everything that was posted. */
function boot(opts: { pin?: { set: boolean; locked: boolean }; openSession?: () => Response } = {}) {
  const posts: Wire[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/setup/status') return json({ needsOwner: false, completed: true, step: null });
    if (url === '/api/auth/me') return json({ person: OWNER, csrf: 'c', permissions: [], pin: opts.pin ?? { set: false, locked: false } });
    if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'DELETE') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url === '/api/auth/open' && opts.openSession) return opts.openSession();
      return new Response(null, { status: url === '/api/send/phone' ? 201 : 204 });
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, posts };
}

const app = () => render(<MemoryRouter><SessionProvider><Layout /></SessionProvider></MemoryRouter>);
// The suite runs a dozen files at once, so the default one-second wait is a flake waiting to
// happen on a loaded machine. Everything here that waits for a render gets room.
const SLOW = { timeout: 5000 };
const openTheLock = () => screen.findByRole('heading', { name: copy.lock.title }, SLOW);
const signedIn = () => screen.findByRole('button', { name: copy.account.menu }, SLOW);
/** The same room for the assertions that wait on a fetch. */
const waitForSlow = (fn: () => unknown) => waitFor(fn, SLOW);

describe('PIN lock', () => {
  it('covers the whole app while the PIN is owed, and the PIN opens it', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    // Nothing of the app is on screen: no account menu, no page.
    expect(screen.queryByRole('button', { name: copy.account.menu })).toBeNull();
    expect(screen.getByLabelText(copy.confirm.yourPin)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(copy.confirm.yourPin), { target: { value: PIN } });
    fireEvent.click(screen.getByRole('button', { name: copy.lock.continueLabel }));
    await waitForSlow(() => expect(posts).toEqual([{ url: '/api/auth/open', body: { pin: PIN } }]));
    await signedIn();
  });

  it('does not open on a PIN shorter than six digits, and posts nothing', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPin), { target: { value: '2468' } });
    expect(screen.getByRole('button', { name: copy.lock.continueLabel })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: copy.lock.continueLabel }));
    expect(posts).toEqual([]);
  });

  it('takes the password when the PIN has been forgotten', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.usePassword }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: copy.lock.continueLabel }));
    await waitForSlow(() => expect(posts).toEqual([{ url: '/api/auth/open', body: { password: PASSWORD } }]));
    await signedIn();
  });

  it('stays up and says what the server said when the PIN is wrong', async () => {
    boot({ pin: { set: true, locked: true }, openSession: () => json({ error: { code: 'pin_wrong', message: 'That PIN is wrong.' } }, 403) });
    app();
    await openTheLock();
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPin), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: copy.lock.continueLabel }));
    await waitForSlow(() => expect(screen.getByRole('alert')).toHaveTextContent('That PIN is wrong.'));
    expect(screen.getByRole('heading', { name: copy.lock.title })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.account.menu })).toBeNull();
  });

  it('locks on a page load when the server still had the session open', async () => {
    const { posts } = boot({ pin: { set: true, locked: false } });
    app();
    await openTheLock();
    // A browser reopened on a phone that may no longer be the owner's is the case the lock is for,
    // so the server is told as well — and not merely a screen drawn over an open session.
    await waitForSlow(() => expect(posts.map((p) => p.url)).toEqual(['/api/auth/lock']));
  });

  it('locks when the page goes to the background, and 30 quiet minutes lock it too', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
    app();
    await openTheLock();
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPin), { target: { value: PIN } });
    fireEvent.click(screen.getByRole('button', { name: copy.lock.continueLabel }));
    await signedIn();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await openTheLock();
    await waitForSlow(() => expect(posts.map((p) => p.url)).toEqual(['/api/auth/open', '/api/auth/lock']));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('asks for the PIN on a money action, and sends it as a PIN', async () => {
    const { posts } = boot({ pin: { set: true, locked: true } });
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
    // The real shell: locked means the LockScreen instead of the page, so the page is only
    // reachable once the PIN has been entered.
    render(
      <MemoryRouter>
        <SessionProvider>
          <Routes><Route element={<Layout />}><Route path="/" element={<StepUpPage />} /></Route></Routes>
        </SessionProvider>
      </MemoryRouter>,
    );
    await openTheLock();
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPin), { target: { value: PIN } });
    fireEvent.click(screen.getByRole('button', { name: copy.lock.continueLabel }));
    await waitForSlow(() => expect(screen.queryByRole('heading', { name: copy.lock.title })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPin), { target: { value: PIN } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
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

    const second = boot({ pin: { set: true, locked: false } });
    render(<SessionProvider><PinCard stepUp={stepUp} /></SessionProvider>);
    fireEvent.click(await screen.findByRole('button', { name: copy.account.pin.remove }, SLOW));
    await waitForSlow(() => expect(second.posts).toContainEqual({ url: '/api/auth/pin', body: { password: PASSWORD } }));
  });
});
