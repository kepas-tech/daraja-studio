import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Invoices, InvoiceDetail } from '../pages/Invoices';
import { copy } from '../copy/en';
import { answer, next } from './questionnaire';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
vi.mock('../app/session', () => ({ useSession: () => ({ status: 'ready', person: { id: 'p1', display_name: 'Owner', is_owner: true }, org: null, permissions: [], refresh: async () => {} }) }));
afterEach(() => cleanup());

const settings = (over: Record<string, unknown> = {}) => ({ mode: 'sandbox', optedIn: true, optedInAt: '2026-09-16T07:00:00Z', email: 'bills@kepas.example', phone: '254700000000', reminders: true, publicVerified: true, ...over });
const inv = (over: Record<string, unknown> = {}) => ({ id: 'i1', reference: 'INV-000001', customerName: 'Jane Doe', customerPhone: '254700123456', invoiceName: 'September rent', accountReference: 'HSE-12', billedPeriod: 'September 2026', dueDate: '2026-09-30', amountCents: 150000, paidCents: 0, items: [], status: 'sent', stored: 'sent', createdBy: null, sentAt: '2026-09-16T07:00:00Z', paidAt: null, cancelledAt: null, payments: [], ...over });

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key] ?? handlers[key.split('?')[0]];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('Invoices', () => {
  it('asks the owner to set up invoicing first, one question at a time, then posts with the password', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/invoices/settings': () => new Response(JSON.stringify(settings({ optedIn: false, email: null, phone: null, reminders: false })), { status: 200 }),
      'GET /api/invoices': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      'POST /api/invoices/opt-in': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(settings({ optedIn: false, registering: true })), { status: 202 }); },
    }));
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await screen.findByText(copy.invoices.optIn.intro);
    answer(copy.invoices.optIn.email, 'bills@kepas.example');
    answer(copy.invoices.optIn.contact, '0700000000', { exact: false });
    fireEvent.click(screen.getByRole('button', { name: copy.invoices.optIn.button }));
    await screen.findByText(copy.invoices.optIn.confirm);
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toEqual({ email: 'bills@kepas.example', officialContact: '254700000000', sendReminders: false, password: 'pw' }));
  });

  it('lists invoices with their status and sends a new one through the questionnaire', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/invoices/settings': () => new Response(JSON.stringify(settings()), { status: 200 }),
      'GET /api/invoices': () => new Response(JSON.stringify({ items: [inv(), inv({ id: 'i2', reference: 'INV-000002', status: 'overdue', customerName: 'John' })] }), { status: 200 }),
      'POST /api/invoices': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(inv({ id: 'i3', reference: 'INV-000003' })), { status: 201 }); },
      'GET /api/invoices/i3': () => new Response(JSON.stringify(inv({ id: 'i3', reference: 'INV-000003' })), { status: 200 }),
    }));
    render(<MemoryRouter initialEntries={['/invoices']}><Routes><Route path="/invoices" element={<Invoices />} /><Route path="/invoices/:id" element={<InvoiceDetail />} /></Routes></MemoryRouter>);
    await screen.findByText('INV-000001 · Jane Doe');
    expect(screen.getAllByText(copy.invoices.status.overdue).length).toBeGreaterThan(1); // the filter option and the pill
    fireEvent.click(screen.getByRole('button', { name: copy.invoices.new }));
    answer(copy.invoices.form.customerName, 'Jane Doe');
    answer(copy.invoices.form.customerPhone, '0700123456', { exact: false });
    answer(copy.invoices.form.invoiceName, 'September rent');
    answer(copy.invoices.form.accountReference, 'HSE-12');
    answer(copy.invoices.form.billedPeriod, 'September 2026');
    answer(copy.invoices.form.dueDate, '2026-09-30');
    next(); // no line items
    fireEvent.change(screen.getByLabelText(copy.invoices.form.amount), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: copy.invoices.form.send }));
    await waitFor(() => expect(posted).toMatchObject({ customerName: 'Jane Doe', customerPhone: '0700123456', accountReference: 'HSE-12', dueDate: '2026-09-30', amountCents: 150000 }));
    await screen.findByText('INV-000003 · Jane Doe');
  });

  it('the invoice page cancels an unpaid one and records a payment made another way', async () => {
    let recorded: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/invoices/i1': () => new Response(JSON.stringify(inv({ paidCents: 50000, stored: 'partly_paid', status: 'partly_paid', payments: [{ id: 'r1', amountCents: 50000, receipt: 'BM1', at: '2026-09-16T08:00:00Z', source: 'callback' }] })), { status: 200 }),
      'POST /api/invoices/i1/payment': (init) => { recorded = JSON.parse(String(init?.body)); return new Response(JSON.stringify(inv({ paidCents: 150000, stored: 'paid', status: 'paid' })), { status: 200 }); },
    }));
    render(<MemoryRouter initialEntries={['/invoices/i1']}><Routes><Route path="/invoices/:id" element={<InvoiceDetail />} /></Routes></MemoryRouter>);
    await screen.findByText('BM1', { exact: false });
    expect(screen.queryByRole('button', { name: copy.invoices.cancel })).toBeNull(); // partly paid: no cancel
    fireEvent.click(screen.getByRole('button', { name: copy.invoices.record }));
    answer(copy.invoices.recordDate, '2026-09-16');
    fireEvent.change(screen.getByLabelText(copy.invoices.recordAmount), { target: { value: '1000' } });
    next();
    answer(copy.invoices.recordReference, 'CASH-1');
    fireEvent.click(screen.getByRole('button', { name: copy.invoices.record }));
    await waitFor(() => expect(recorded).toEqual({ paymentDate: '2026-09-16', reference: 'CASH-1', payer: '', amountCents: 100000 }));
    await waitFor(() => expect(screen.getAllByText(copy.invoices.status.paid).length).toBeGreaterThan(0));
  });
});
