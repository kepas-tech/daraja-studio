import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Approvals } from '../pages/Approvals';
import { ApprovalsSection } from '../pages/settings/ApprovalsSection';
import { copy } from '../copy/en';
import type { SettingsView } from '../api/types';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
vi.mock('../app/session', () => ({ useSession: () => ({ status: 'ready', person: { id: 'anna', display_name: 'Anna', is_owner: false }, org: null, permissions: ['send.approve'], refresh: async () => {} }) }));
afterEach(() => cleanup());

const held = (over: Record<string, unknown> = {}) => ({ id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'awaiting_approval', amountCents: 500000, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: 'Rent', receipt: null, category: 'Rent', createdAt: '2026-09-16T07:15:30Z', sentAt: null, resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'owner', displayName: 'Nelson' }, approvedBy: null, ...over });

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('Waiting for approval', () => {
  it('lists held sends and releases one after the password', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/approvals': () => new Response(JSON.stringify({ items: [held()], nextCursor: null }), { status: 200 }),
      'POST /api/approvals/r1/release': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(held({ status: 'sent' })), { status: 201 }); },
    }));
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await screen.findByText('Nelson');
    fireEvent.click(screen.getByRole('button', { name: copy.approvals.release }));
    await screen.findByText(copy.approvals.confirmRelease('KES 5,000'));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toEqual({ password: 'correct horse' }));
  });

  it('refusing needs a reason, and sends it', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/approvals': () => new Response(JSON.stringify({ items: [held()], nextCursor: null }), { status: 200 }),
      'POST /api/approvals/r1/refuse': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(held({ status: 'rejected' })), { status: 200 }); },
    }));
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await screen.findByText('Nelson');
    fireEvent.click(screen.getByRole('button', { name: copy.approvals.refuse }));
    const refuse = screen.getByRole('button', { name: copy.approvals.refuse });
    expect(refuse).toBeDisabled();
    fireEvent.change(screen.getByLabelText(copy.approvals.reason), { target: { value: 'Wrong supplier' } });
    fireEvent.click(refuse);
    await waitFor(() => expect(posted).toEqual({ reason: 'Wrong supplier' }));
  });

  it('your own send shows no buttons', async () => {
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/approvals': () => new Response(JSON.stringify({ items: [held({ createdBy: { id: 'anna', displayName: 'Anna' } })], nextCursor: null }), { status: 200 }),
    }));
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    await screen.findByText(copy.approvals.own);
    expect(screen.queryByRole('button', { name: copy.approvals.release })).toBeNull();
  });
});

describe('Settings › Approvals', () => {
  const slot = { shortcode: null, consumerKey: 'none', consumerSecret: 'none', credsVerifiedAt: null, passkey: 'none', certPem: 'none', b2cApi: { setting: 'auto', detected: null, detectedAt: null }, ready: { creds: false, operator: false }, operators: [] };
  const view = { mode: 'sandbox', environments: { sandbox: slot, production: slot }, org: { name: 'KEPAS', nominatedNumber: '', notificationPhone: '' }, stkEnabled: false, publicUrl: null, publicVerifiedAt: null, httpsSeen: false, allowlist: [], setupCompletedAt: 'x', sendCategories: [], approvalThresholdCents: 0 } as unknown as SettingsView;
  const stepUp = { ask: vi.fn((_t: string, run: (pw: string) => Promise<void>) => { void run('pw'); }), dialogProps: { open: false, title: '', busy: false, error: null, onConfirm: () => {}, onCancel: () => {} } };

  it('shows Off, and saving a threshold puts the cents', async () => {
    let put: unknown = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { put = { url: String(input), body: JSON.parse(String(init?.body)) }; return new Response(null, { status: 204 }); }));
    render(<ApprovalsSection view={view} reload={async () => {}} stepUp={stepUp} />);
    expect(screen.getByText(copy.settings.approvals.off)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.settings.change }));
    fireEvent.change(screen.getByLabelText(copy.settings.approvals.field), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: copy.settings.save }));
    await waitFor(() => expect(put).toEqual({ url: '/api/settings/approval-threshold', body: { cents: 500000, password: 'pw' } }));
  });

  it('shows the threshold when on', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<ApprovalsSection view={{ ...view, approvalThresholdCents: 500000 }} reload={async () => {}} stepUp={stepUp} />);
    expect(screen.getByText(copy.settings.approvals.holdFrom('KES 5,000'))).toBeInTheDocument();
  });
});
