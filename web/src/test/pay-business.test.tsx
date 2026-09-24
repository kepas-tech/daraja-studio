import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PayBusiness } from '../pages/send/PayBusiness';
import { copy } from '../copy/en';
import { answer } from './questionnaire';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

const c = copy.payBusiness;
const sent = { id: 'r1', type: 'b2b', subtype: 'BusinessPayBill', status: 'sent', amountCents: 50000, currency: 'KES', recipient: { kind: 'paybill', value: '888880', name: 'ACME TRADERS' }, party: { name: 'ACME TRADERS', number: '888880', savedName: null }, direction: 'out', remarks: null, receipt: null, accountReference: 'METER42', createdAt: '2026-09-24T11:00:00Z', sentAt: '2026-09-24T11:00:01Z', resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function fetchFor(opts: { workingCents?: number; onPay?: (body: unknown) => void; onCheck?: (body: unknown) => void } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    if (key === 'GET /api/businesses') return json({ items: [], lastUsedId: null });
    if (key.startsWith('GET /api/contacts?kind=')) return json({ items: [] });
    if (key === 'GET /api/balances/latest') return json({ workingCents: opts.workingCents ?? 10_000_00, utilityCents: 0, chargesPaidCents: 0, queriedAt: new Date().toISOString(), waitingCents: 0 });
    if (key === 'GET /healthz') return json({ sendCapCents: null });
    if (key.startsWith('GET /api/fees/charge?kind=b2b')) return json({ chargeCents: 1300 });
    if (key === 'POST /api/send/business-check') { opts.onCheck?.(JSON.parse(String(init?.body))); return json({ available: true, name: 'ACME TRADERS', paidBefore: true }); }
    if (key === 'POST /api/send/business') { opts.onPay?.(JSON.parse(String(init?.body))); return json(sent, 201); }
    throw new Error(`unexpected fetch ${key}`);
  });
}

describe('PayBusiness', () => {
  it('paybill: number, account, amount → review names the business → password → sent', async () => {
    let paid: unknown = null; let asked: unknown = null;
    vi.stubGlobal('fetch', fetchFor({ onPay: (b) => { paid = b; }, onCheck: (b) => { asked = b; } }));
    render(<MemoryRouter><PayBusiness to="paybill" /></MemoryRouter>);
    await screen.findByLabelText(c.number.paybill);
    answer(c.number.paybill, '888880');
    answer(c.account, 'METER42');
    answer(c.amount, '500', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: c.next }));
    await screen.findByText(c.review.title);

    expect(await screen.findByText(c.review.name('ACME TRADERS'))).toBeInTheDocument();
    expect(asked).toEqual({ to: 'paybill', shortcode: '888880' });
    expect(screen.getByText('METER42')).toBeInTheDocument();
    expect(await screen.findByText(c.review.charge('KES 13'))).toBeInTheDocument();
    expect(screen.getByText(c.review.debits)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: c.pay }));
    expect(screen.getByRole('dialog')).toHaveTextContent(c.confirmTitle('KES 500', 'ACME TRADERS'));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    expect(await screen.findByRole('status')).toHaveTextContent(c.result.sent);
    expect(paid).toMatchObject({ to: 'paybill', shortcode: '888880', accountReference: 'METER42', amountCents: 50000, recipientName: 'ACME TRADERS', password: 'studio-pw' });
  });

  it('till: asks no account number, and sends none', async () => {
    let paid: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', fetchFor({ onPay: (b) => { paid = b as Record<string, unknown>; } }));
    render(<MemoryRouter><PayBusiness to="till" /></MemoryRouter>);
    await screen.findByLabelText(c.number.till);
    answer(c.number.till, '123456');
    expect(screen.queryByLabelText(c.account)).toBeNull();
    answer(c.amount, '100', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: c.next }));
    await screen.findByText(c.review.title);
    fireEvent.click(screen.getByRole('button', { name: c.pay }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(paid).not.toBeNull());
    expect(paid!.to).toBe('till');
    expect(paid!.accountReference).toBeUndefined();
  });

  it('says so and will not pay when Working cannot cover the payment and the charge', async () => {
    vi.stubGlobal('fetch', fetchFor({ workingCents: 50000 }));
    render(<MemoryRouter><PayBusiness to="till" /></MemoryRouter>);
    await screen.findByLabelText(c.number.till);
    answer(c.number.till, '123456');
    answer(c.amount, '500', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: c.next }));
    expect(await screen.findByText(c.review.short)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: c.pay })).toBeDisabled();
  });
});
