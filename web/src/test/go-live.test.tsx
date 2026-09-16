import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { GoLive, stepsFor } from '../pages/GoLive';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';
import type { SettingsView } from '../api/types';

afterEach(() => cleanup());
vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });

const slot = (over: object = {}) => ({
  shortcode: null,
  consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null,
  passkey: { saved: false, last4: null }, passkeyProven: false, cert: { saved: false, last4: null },
  operators: [], ready: { creds: false, operator: false },
  b2cApi: { setting: 'auto', detected: null, detectedAt: null },
  ...over,
});
const base = {
  mode: 'sandbox',
  environments: { sandbox: slot({ shortcode: '174379', ready: { creds: true, operator: true } }), production: slot() },
  org: { name: 'ACME TRADERS', nominatedNumber: '254700000000', notificationPhone: '254700000000' },
  stkEnabled: true, publicUrl: 'https://x', publicVerifiedAt: 'x', httpsSeen: true, allowlist: [], setupCompletedAt: 'x',
  sendCategories: [], approvalThresholdCents: 0, uses: { payOut: true, collect: true, stk: false },
};

function mount(views: unknown[], handlers: (url: string, method: string, init?: RequestInit) => Response) {
  let gets = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: 'done' }), { status: 200 });
    if (url === '/api/auth/me') return new Response(JSON.stringify({ person: { id: 'p1', username: 'amina', display_name: 'Amina', is_owner: true, must_change_password: false }, csrf: 'c', permissions: [], org: { id: 'o1', name: 'ACME TRADERS', status: 'verified', environment: 'sandbox', isHost: true, suspendReason: null } }), { status: 200 });
    if (url === '/api/settings' && method === 'GET') { const v = views[Math.min(gets, views.length - 1)]; gets += 1; return new Response(JSON.stringify(v), { status: 200 }); }
    return handlers(url, method, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><SessionProvider><ToastHost /><GoLive /></SessionProvider></MemoryRouter>);
  return fetchMock;
}
const password = async (pw = 'owner-pw') => {
  fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: pw } });
  fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
};

describe('Go live', () => {
  it('lists the steps from what the business uses', () => {
    expect(stepsFor(base as unknown as SettingsView)).toEqual(['need', 'number', 'keys', 'switch', 'operator', 'done']);
    expect(stepsFor({ ...base, uses: { payOut: false, collect: true, stk: true } } as unknown as SettingsView)).toEqual(['need', 'number', 'keys', 'switch', 'passkey', 'done']);
  });

  it('says so when the studio already runs on real money', async () => {
    mount([{ ...base, mode: 'production', environments: { ...base.environments, production: slot({ shortcode: '700111', ready: { creds: true, operator: true } }) } }], () => { throw new Error('none'); });
    expect(await screen.findByText(copy.goLive.alreadyLive)).toBeInTheDocument();
  });

  it('asks the password once, saves the number, then the keys, and skips a step already done', async () => {
    const afterNumber = { ...base, environments: { ...base.environments, production: slot({ shortcode: '700111', safaricomName: 'ACME' }) } };
    const afterKeys = { ...afterNumber, environments: { ...afterNumber.environments, production: slot({ shortcode: '700111', consumerKey: { saved: true, last4: 'abcd' }, credsVerifiedAt: 'x', ready: { creds: true, operator: false } }) } };
    const bodies: Record<string, unknown> = {};
    mount([base, afterNumber, afterKeys], (url, method, init) => {
      bodies[`${method} ${url}`] = JSON.parse(String(init?.body));
      if (url === '/api/settings/environments/production/shortcode' && method === 'PUT') return new Response(JSON.stringify({ verifiedName: 'ACME', verifyError: null }), { status: 200 });
      if (url === '/api/settings/environments/production/daraja' && method === 'POST') return new Response(JSON.stringify({ ok: true, message: 'Safaricom accepted the key and secret.' }), { status: 200 });
      throw new Error(`unexpected ${method} ${url}`);
    });
    // Step 1: what you need, with the Safaricom trails.
    await screen.findByText(copy.goLive.steps.need);
    expect(screen.getAllByTestId('safaricom-how').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: copy.goLive.continueLabel }));
    // Step 2: the number; the password is asked here, once.
    await screen.findByText(copy.goLive.steps.number);
    fireEvent.change(screen.getByLabelText(copy.settings.shortcode.label), { target: { value: '700111' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.save }));
    await password();
    await waitFor(() => expect(bodies['PUT /api/settings/environments/production/shortcode']).toEqual({ shortcode: '700111', password: 'owner-pw' }));
    // Step 3: keys, no second password prompt.
    await screen.findByText(copy.goLive.steps.keys);
    fireEvent.change(screen.getByLabelText(copy.setup.daraja.key), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: copy.questionnaire.next }));
    fireEvent.change(screen.getByLabelText(copy.setup.daraja.secret), { target: { value: 's' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.save }));
    await waitFor(() => expect(bodies['POST /api/settings/environments/production/daraja']).toEqual({ consumerKey: 'k', consumerSecret: 's', password: 'owner-pw' }));
    expect(screen.queryByLabelText(copy.confirm.yourPassword)).toBeNull();
    // Step 4: the switch.
    await screen.findByText(copy.goLive.steps.switch);
    expect(screen.getByLabelText(copy.goLive.switchMode.field)).toBeInTheDocument();
  });

  it('switches to real money only with the number typed back, then reaches Done', async () => {
    const ready = { ...base, environments: { ...base.environments, production: slot({ shortcode: '700111', credsVerifiedAt: 'x', ready: { creds: true, operator: true }, operators: [{ id: 'o', name: 'APIONE', environment: 'production', status: 'verified', priority: 1, rotatedAt: 'x', lastProbeAt: null, lastError: null, expiresAt: 'x' }] }) } };
    const live = { ...ready, mode: 'production' };
    let attempt = 0;
    mount([ready, ready, live], (url, method, init) => {
      if (url === '/api/settings/mode' && method === 'PUT') {
        attempt += 1;
        const b = JSON.parse(String(init?.body));
        if (b.confirmShortcode !== '700111') return new Response(JSON.stringify({ error: { code: 'confirm_shortcode', message: 'Type your shortcode exactly to switch to production.' } }), { status: 400 });
        return new Response(JSON.stringify({ mode: 'production', ready: { creds: true, operator: true } }), { status: 200 });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    await screen.findByText(copy.goLive.steps.need);
    fireEvent.click(screen.getByRole('button', { name: copy.goLive.continueLabel }));
    // Number and keys are already done: one Continue each.
    await screen.findByText(copy.goLive.number.done(null).slice(0, 5), { exact: false });
    fireEvent.click(screen.getByRole('button', { name: copy.goLive.continueLabel }));
    await screen.findByText(copy.goLive.keys.done);
    fireEvent.click(screen.getByRole('button', { name: copy.goLive.continueLabel }));
    await screen.findByText(copy.goLive.steps.switch);
    fireEvent.change(screen.getByLabelText(copy.goLive.switchMode.field), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: copy.goLive.switchMode.button }));
    await password();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Type your shortcode exactly'));
    fireEvent.change(screen.getByLabelText(copy.goLive.switchMode.field), { target: { value: '700111' } });
    fireEvent.click(screen.getByRole('button', { name: copy.goLive.switchMode.button }));
    await waitFor(() => expect(attempt).toBe(2));
    // Operator already verified: Continue, then Done.
    await screen.findByText(copy.setup.operator.verified);
    fireEvent.click(screen.getByRole('button', { name: copy.goLive.continueLabel }));
    expect(await screen.findByText(copy.goLive.done.title)).toBeInTheDocument();
  });
});
