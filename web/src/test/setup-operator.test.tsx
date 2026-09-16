import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Operator } from '../pages/setup/Operator';
import { copy } from '../copy/en';
import { answer, next } from './questionnaire';

// This file's vitest config does not set `test.globals: true`, so Testing
// Library's automatic per-test cleanup (which hooks the global `afterEach`)
// never registers — clean up explicitly so the two tests below don't see
// each other's rendered DOM.
afterEach(() => cleanup());

// jsdom has no EventSource; Operator subscribes to live updates via useEvents.
class FakeEventSource {
  addEventListener() {}
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);

const emptySlot = { shortcode: null, consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null, passkey: { saved: false, last4: null }, cert: { saved: false, last4: null }, operators: [], ready: { creds: false, operator: false }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } };
const view = { mode: 'sandbox', environments: { sandbox: emptySlot, production: emptySlot }, org: { name: '', nominatedNumber: '', notificationPhone: '' }, stkEnabled: false, publicUrl: null, publicVerifiedAt: null, httpsSeen: false, allowlist: [], setupCompletedAt: null };

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/settings') return new Response(JSON.stringify(view), { status: 200 });
    if (url === '/api/setup/operator') return new Response(JSON.stringify({ id: 'op1' }), { status: 201 });
    throw new Error(`unexpected fetch to ${url} ${init?.method ?? ''}`);
  });
}

describe('Setup › Operator', () => {
  it('posts only the credential-mode fields by default', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Operator onDone={() => {}} onBack={() => {}} /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.anything()));

    expect(screen.getByTestId('safaricom-how')).toHaveTextContent('Organization Operator');
    answer(copy.setup.operator.name, 'KEPAS');
    next();
    const credentialField = screen.getByLabelText(copy.setup.operator.credential);
    expect(credentialField).toHaveAttribute('autocomplete', 'off');
    fireEvent.change(credentialField, { target: { value: 'the-credential' } });
    fireEvent.click(screen.getByRole('button', { name: copy.setup.operator.add }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/setup/operator', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/setup/operator');
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({ name: 'KEPAS', credential: 'the-credential' });
    expect(body).not.toHaveProperty('operatorPassword');
  });

  it('posts only the password-mode fields after switching modes', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Operator onDone={() => {}} onBack={() => {}} /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.anything()));

    answer(copy.setup.operator.name, 'KEPAS');
    fireEvent.click(screen.getByLabelText(copy.setup.operator.modePassword));
    next();
    answer(copy.setup.operator.password, 'op-password');
    fireEvent.change(screen.getByLabelText(copy.setup.operator.cert), { target: { value: '-----BEGIN CERTIFICATE-----' } });
    fireEvent.click(screen.getByRole('button', { name: copy.setup.operator.add }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/setup/operator', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/setup/operator');
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({ name: 'KEPAS', operatorPassword: 'op-password', certPem: '-----BEGIN CERTIFICATE-----' });
    expect(body).not.toHaveProperty('credential');
  });
});
