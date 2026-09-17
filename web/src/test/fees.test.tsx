import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SendPhone } from '../pages/send/SendPhone';
import { History } from '../pages/History';
import { Settings } from '../pages/Settings';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';
import { money } from '../format';
import { answer, next } from './questionnaire';

vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
afterEach(() => cleanup());

const band = (over: object = {}) => ({ id: 'f1', kind: 'b2c', minCents: 100, maxCents: 50000, chargeCents: 700, updatedAt: '2026-09-17T00:00:00Z', ...over });
const balance = { workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: new Date().toISOString() };

async function fillForm() {
  await screen.findByLabelText(copy.send.phone.recipient, { exact: false });
  answer(copy.send.phone.recipient, '0700123456', { exact: false });
  answer(copy.send.phone.amount, '1', { exact: false });
  next();
  fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
  await screen.findByText(copy.send.phone.review.title);
}

describe('the charge on the send review', () => {
  const stub = (chargeCents: number | null) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    if (key.startsWith('GET /api/fees/charge')) return new Response(JSON.stringify({ chargeCents }), { status: 200 });
    if (key === 'GET /api/send/categories') return new Response(JSON.stringify({ items: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }] }), { status: 200 });
    if (key === 'GET /api/contacts?kind=phone') return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (key === 'GET /api/businesses') return new Response(JSON.stringify({ items: [], lastUsedId: null }), { status: 200 });
    if (key === 'GET /api/balances/latest') return new Response(JSON.stringify(balance), { status: 200 });
    if (key === 'POST /api/send/name-check') return new Response(JSON.stringify({ available: false, reason: 'not_enabled', said: null }), { status: 200 });
    if (key === 'GET /healthz') return new Response(JSON.stringify({ sendCapCents: null }), { status: 200 });
    throw new Error('unexpected fetch ' + key);
  }));

  it('shows what Safaricom will charge, taken from Utility', async () => {
    stub(1300);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    expect(await screen.findByText(copy.send.phone.review.charge(money(1300)))).toBeInTheDocument();
  });

  it('says so when no band covers the amount, rather than showing a zero', async () => {
    stub(null);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    expect(await screen.findByText(copy.send.phone.review.chargeNone)).toBeInTheDocument();
  });
});

describe('the charge in History', () => {
  it('shows the charge stored on the row, and a dash when there is none', async () => {
    const row = (id: string, chargeCents: number | null) => ({ id, type: 'b2c', subtype: 'BusinessPayment', status: 'completed', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: null, receipt: 'RI' + id, createdAt: '2026-09-06T11:00:00Z', sentAt: null, resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' }, chargeCents });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/businesses')) return new Response(JSON.stringify({ items: [], lastUsedId: null }), { status: 200 });
      return new Response(JSON.stringify({ items: [row('1', 1300), row('2', null)], nextCursor: null }), { status: 200 });
    }));
    render(<MemoryRouter><History /></MemoryRouter>);
    expect(await screen.findByRole('columnheader', { name: copy.history.columns.charge })).toBeInTheDocument();
    expect(screen.getByText(money(1300))).toBeInTheDocument();
    const blank = screen.getAllByRole('row').find((r) => r.textContent?.includes('RI2'));
    expect(within(blank as HTMLElement).getByText('—')).toBeInTheDocument();
  });
});

describe('Settings > Safaricom’s charges', () => {
  const slot = { shortcode: null, consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null, passkey: { saved: false, last4: null }, cert: { saved: false, last4: null }, operators: [], ready: { creds: false, operator: false }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } };
  const view = { mode: 'sandbox', environments: { sandbox: slot, production: slot }, org: { name: 'APIONE', nominatedNumber: '', notificationPhone: '' }, stkEnabled: false, publicUrl: null, publicVerifiedAt: null, httpsSeen: false, allowlist: [], setupCompletedAt: 'x', sendCategories: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }], approvalThresholdCents: 0 };

  it('renders the bands and saves an edit with the owner’s password', async () => {
    const puts: unknown[] = [];
    let gets = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') return new Response(JSON.stringify(view), { status: 200 });
      if (url === '/api/fees' && method === 'GET') { gets++; return new Response(JSON.stringify({ items: [band()] }), { status: 200 }); }
      if (url === '/api/fees/b2c' && method === 'PUT') { puts.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ items: [band()] }), { status: 200 }); }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no' } }), { status: 404 });
    }));
    render(<MemoryRouter><ToastHost /><Settings /></MemoryRouter>);
    const section = await screen.findByTestId('charges-b2c');
    const c = copy.settings.charges;
    fireEvent.change(within(section).getByLabelText(c.kinds.b2c + ' ' + c.charge + ' 1'), { target: { value: '9' } });
    fireEvent.click(within(section).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ bands: [{ minCents: 100, maxCents: 50000, chargeCents: 900 }], password: 'pw' });
    // Let the section's own reload settle before the test ends: pending React work at teardown is
    // what turns into a stray "window is not defined" in a parallel run.
    await waitFor(() => expect(gets).toBe(2));
  });
});
