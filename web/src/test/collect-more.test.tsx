import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StandingOrders } from '../pages/collect/StandingOrders';
import { Express } from '../pages/collect/Express';
import { Bonga } from '../pages/collect/Bonga';
import { copy } from '../copy/en';
import { answer, next } from './questionnaire';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

const row = (over: Record<string, unknown> = {}) => ({ id: 'r1', type: 'ratiba', subtype: null, status: 'sent', amountCents: 500000, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: 'Rent', receipt: null, category: null, createdAt: '2026-09-16T07:00:00Z', sentAt: '2026-09-16T07:00:01Z', resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null, ...over });
function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key] ?? handlers[key.split('?')[0]];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('Standing orders', () => {
  it('lists orders, and creates one through the questionnaire with the fixed-schedule note on review', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/requests': () => new Response(JSON.stringify({ items: [row({ status: 'completed' })], nextCursor: null }), { status: 200 }),
      'POST /api/collect/ratiba': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(row({ id: 'r2', remarks: 'Water' })), { status: 201 }); },
      'GET /api/requests/r2': () => new Response(JSON.stringify(row({ id: 'r2', remarks: 'Water' })), { status: 200 }),
    }));
    render(<MemoryRouter><StandingOrders /></MemoryRouter>);
    await screen.findByText('Rent');
    expect(screen.getByText(copy.standingOrders.active)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.standingOrders.new }));
    answer(copy.standingOrders.name, 'Water');
    answer(copy.standingOrders.phone, '0700123456', { exact: false });
    fireEvent.change(screen.getByLabelText(copy.standingOrders.amount), { target: { value: '5000' } });
    next();
    next(); // monthly
    answer(copy.standingOrders.startDate, '2026-10-01');
    answer(copy.standingOrders.endDate, '2027-09-30');
    answer(copy.standingOrders.account, 'HSE-12');
    fireEvent.click(screen.getByRole('button', { name: copy.standingOrders.review })); // the note is optional and last
    await screen.findByText(copy.standingOrders.fixedNote);
    fireEvent.click(screen.getByRole('button', { name: copy.standingOrders.create }));
    await waitFor(() => expect(posted).toMatchObject({ name: 'Water', phone: '0700123456', amountCents: 500000, frequency: '4', startDate: '2026-10-01', endDate: '2027-09-30', accountReference: 'HSE-12', transactionType: 'paybill' }));
    await screen.findByText(copy.standingOrders.result.sent);
  });
});

describe('Express checkout', () => {
  it('asks for the till, amount and reference, then posts', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'POST /api/collect/express': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(row({ type: 'express', recipient: { kind: 'shortcode', value: '174379', name: null } })), { status: 201 }); },
      'GET /api/requests/r1': () => new Response(JSON.stringify(row({ type: 'express' })), { status: 200 }),
    }));
    render(<MemoryRouter><Express /></MemoryRouter>);
    answer(copy.express.till, '174379');
    fireEvent.change(screen.getByLabelText(copy.askToPay.amount), { target: { value: '2500' } });
    next();
    answer(copy.express.reference, 'PO-77');
    fireEvent.click(screen.getByRole('button', { name: copy.askToPay.next })); // the partner name is optional and last
    fireEvent.click(screen.getByRole('button', { name: copy.express.ask }));
    await waitFor(() => expect(posted).toMatchObject({ till: '174379', amountCents: 250000, paymentRef: 'PO-77' }));
    await screen.findByText(copy.express.result.sent);
  });
});

describe('Bonga points', () => {
  it('values the points as they are typed, then redeems', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/money-in/status': () => new Response(JSON.stringify({ mode: 'sandbox', c2bRegisteredAt: '2026-09-16T07:00:00Z', pullRegisteredAt: null, pullCheckedAt: null, nominatedNumber: null, publicVerified: true }), { status: 200 }),
      'POST /api/collect/bonga/calculate': () => new Response(JSON.stringify({ points: 500, amountCents: 10000, rate: 0.2 }), { status: 200 }),
      'POST /api/collect/bonga/redeem': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(row({ type: 'bonga', amountCents: 10000 })), { status: 201 }); },
      'GET /api/requests/r1': () => new Response(JSON.stringify(row({ type: 'bonga' })), { status: 200 }),
    }));
    render(<MemoryRouter><Bonga /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.bonga.points), { target: { value: '500' } });
    await screen.findByText(copy.bonga.worth('KES 100', 0.2));
    next();
    answer(copy.bonga.phone, '0700123456', { exact: false });
    fireEvent.change(screen.getByLabelText(copy.bonga.account), { target: { value: 'ORD-9' } });
    fireEvent.click(screen.getByRole('button', { name: copy.askToPay.next }));
    fireEvent.click(screen.getByRole('button', { name: copy.bonga.redeem }));
    await waitFor(() => expect(posted).toEqual({ phone: '0700123456', points: 500, accountReference: 'ORD-9' }));
    await screen.findByText(copy.bonga.result.sent);
  });
  it('says so when Money in is off', async () => {
    vi.stubGlobal('fetch', fetchFor({ 'GET /api/money-in/status': () => new Response(JSON.stringify({ mode: 'sandbox', c2bRegisteredAt: null, pullRegisteredAt: null, pullCheckedAt: null, nominatedNumber: null, publicVerified: true }), { status: 200 }) }));
    render(<MemoryRouter><Bonga /></MemoryRouter>);
    await screen.findByText(copy.bonga.needsMoneyIn, { exact: false });
  });
});
