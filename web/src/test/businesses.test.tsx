import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import type { BusinessView, CustomerView } from '../api/types';
import { AskToPay } from '../pages/AskToPay';
import { Businesses } from '../pages/Businesses';
import { Bulk } from '../pages/Bulk';
import { CustomerPicker } from '../components/CustomerPicker';
import { History } from '../pages/History';
import { Home } from '../pages/Home';
import { MoneyIn } from '../pages/MoneyIn';
import { SendPhone } from '../pages/send/SendPhone';
import { copy } from '../copy/en';
import { answer, next } from './questionnaire';

const state = vi.hoisted(() => ({ mayManage: true }));
vi.mock('../app/session', () => ({
  useSession: () => ({
    status: 'ready', person: { id: 'p1', is_owner: false },
    org: { id: 'o1', name: 'Test studio', shortcode: '4052037', environment: 'production' },
    permissions: state.mayManage ? ['businesses.manage'] : [],
    refresh: async () => {},
  }),
}));

// Live events are not under test here; SendPhone opens the stream once a send is on screen.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

afterEach(() => { cleanup(); state.mayManage = true; });

const at = '2026-09-17T08:00:00Z';
const kepas: BusinessView = { id: 'b1', code: '000', name: 'Kepas Hardware', active: true, customerCount: 1, createdAt: at };
const rentals: BusinessView = { id: 'b2', code: '001', name: 'Rentals', active: true, customerCount: 0, createdAt: at };
const jane: CustomerView = { id: 'k1', businessId: 'b1', number: 0, display: '000', accountNumber: '000000', name: 'Jane Doe', phone: '254712345678', note: null, createdAt: at };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Handlers = Record<string, (init?: RequestInit) => Response>;

function mountBusinesses(handlers: Handlers = {}, items: BusinessView[] = [kepas, rentals]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    const h = handlers[key];
    if (h) return h(init);
    if (key === 'GET /api/businesses') return json({ items, lastUsedId: null });
    if (key === 'GET /api/businesses/b1/customers') return json({ items: [jane] });
    throw new Error('unexpected fetch ' + key);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><Businesses /></MemoryRouter>);
  return fetchMock;
}

describe('Businesses and their customers', () => {
  it('lists a business with its code and opens its customers, whose account number is code plus number', async () => {
    mountBusinesses();
    const row = await screen.findByTestId('business-b1');
    expect(within(row).getByText(/Kepas Hardware/)).toBeInTheDocument();
    expect(within(row).getByText('000')).toBeInTheDocument();
    expect(within(row).getByText(copy.businesses.customerCount(1))).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.customers }));
    const customer = await screen.findByTestId('customer-k1');
    expect(within(customer).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(customer).getByText('000000')).toBeInTheDocument();
    // The owner is told what to say to the payer: the paybill, then the account number.
    expect(within(customer).getByText(copy.businesses.tellThem('4052037', '000000'))).toBeInTheDocument();
  });

  it('says routing is off with one business and on from the second', async () => {
    mountBusinesses({}, [kepas]);
    expect(await screen.findByText(copy.businesses.routingOff)).toBeInTheDocument();
    cleanup();
    mountBusinesses({}, [kepas, rentals]);
    expect(await screen.findByText(copy.businesses.routingOn)).toBeInTheDocument();
    expect(screen.queryByText(copy.businesses.routingOff)).toBeNull();
  });

  it('offers the next free code, takes a name, and posts both', async () => {
    let posted: unknown = null;
    mountBusinesses({ 'POST /api/businesses': (init) => { posted = JSON.parse(String(init?.body)); return json({ ...rentals, id: 'b9', code: '002', name: 'Farm' }, 201); } });
    await screen.findByTestId('business-b1');
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.add }));
    // 000 and 001 are taken, so the form offers 002.
    expect(screen.getByText(copy.businesses.codeNext('002'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.businesses.name), { target: { value: 'Farm' } });
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.save }));
    await waitFor(() => expect(posted).toEqual({ name: 'Farm', code: '002' }));
  });

  it('switches a business off and on with the same route', async () => {
    const puts: unknown[] = [];
    mountBusinesses({ 'PUT /api/businesses/b1': (init) => { puts.push(JSON.parse(String(init?.body))); return json({ ...kepas, active: false }); } });
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.switchOff }));
    await waitFor(() => expect(puts).toEqual([{ name: 'Kepas Hardware', active: false }]));
  });

  it('adds a customer, sends the normalised phone, and shows the account number the payer must use', async () => {
    let posted: unknown = null;
    mountBusinesses({
      'POST /api/businesses/b1/customers': (init) => { posted = JSON.parse(String(init?.body)); return json({ ...jane, id: 'k9', number: 1, display: '001', accountNumber: '000001', name: 'Peter' }, 201); },
      'GET /api/businesses/b1/customers': () => json({ items: [jane, { ...jane, id: 'k9', number: 1, display: '001', accountNumber: '000001', name: 'Peter' }] }),
    });
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.customers }));
    fireEvent.click(await screen.findByRole('button', { name: copy.businesses.addCustomer }));
    fireEvent.change(screen.getByLabelText(copy.businesses.customerName), { target: { value: 'Peter' } });
    fireEvent.change(screen.getByLabelText(copy.businesses.customerPhone), { target: { value: '0712 000 001' } });
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.save }));
    await waitFor(() => expect(posted).toEqual({ name: 'Peter', phone: '254712000001', note: undefined }));
    expect(await screen.findByText('000001')).toBeInTheDocument();
  });

  it('retires a customer without touching anyone else', async () => {
    let deleted = 0;
    mountBusinesses({ 'DELETE /api/customers/k1': () => { deleted += 1; return new Response(null, { status: 204 }); } });
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.customers }));
    const customer = await screen.findByTestId('customer-k1');
    fireEvent.click(within(customer).getByRole('button', { name: copy.businesses.retire }));
    await waitFor(() => expect(deleted).toBe(1));
  });

  it('keeps the list readable but hides every write without the permission', async () => {
    state.mayManage = false;
    mountBusinesses();
    const row = await screen.findByTestId('business-b1');
    expect(screen.queryByRole('button', { name: copy.businesses.add })).toBeNull();
    expect(within(row).queryByRole('button', { name: copy.businesses.switchOff })).toBeNull();
    expect(within(row).queryByRole('button', { name: copy.businesses.edit })).toBeNull();
    expect(screen.getByText(copy.businesses.noManage)).toBeInTheDocument();
  });
});

function PickerHarness() {
  const [picked, setPicked] = useState<CustomerView | null>(null);
  // The picker's own row also prints the account number, so the harness labels its copy.
  return <><CustomerPicker onPick={setPicked} />{picked && <p>Picked {picked.accountNumber}</p>}</>;
}

describe('The saved-customer picker', () => {
  it('hands the page the customer whose account number the payer will type', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const key = 'GET ' + String(input);
      if (key === 'GET /api/businesses') return json({ items: [kepas], lastUsedId: null });
      if (key === 'GET /api/businesses/b1/customers') return json({ items: [jane] });
      throw new Error('unexpected fetch ' + key);
    }));
    render(<MemoryRouter><PickerHarness /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(jane.name) }));
    expect(await screen.findByText('Picked 000000')).toBeInTheDocument();
  });
});

const balance = { workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: at };
const sent = { id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'sent', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254712345678', name: null }, remarks: null, receipt: null, category: 'Business payment', contactName: null, createdAt: at, sentAt: at, resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null };

describe('Sending money, tagged with a business', () => {
  function mountSend(items: BusinessView[], lastUsedId: string | null) {
    let posted: unknown = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = (init?.method ?? 'GET') + ' ' + String(input);
      if (key === 'GET /api/businesses') return json({ items, lastUsedId });
      if (key === 'GET /api/contacts?kind=phone') return json({ items: [] });
      if (key === 'GET /api/send/categories') return json({ items: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }] });
      if (key === 'GET /api/balances/latest') return json(balance);
      if (key === 'POST /api/send/name-check') return json({ available: false, reason: 'not_enabled', said: null });
      if (key === 'POST /api/send/phone') { posted = JSON.parse(String(init?.body)); return json(sent, 201); }
      throw new Error('unexpected fetch ' + key);
    }));
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    return () => posted;
  }

  it('asks which business from the second one on, defaults to the last used, and sends it', async () => {
    const body = mountSend([kepas, rentals], rentals.id);
    // The first question is the business, already answered by the last-used default.
    expect(await screen.findByLabelText(copy.send.phone.business)).toHaveValue(rentals.id);
    next();
    answer(copy.send.phone.recipient, '0712345678');
    answer(copy.send.phone.amount, '1', { exact: false });
    next();
    // The last question's button reads Review, not Continue.
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.title);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    // The number goes as typed; the server normalises it (contacts.test.tsx asserts the same).
    expect(body()).toMatchObject({ phone: '0712345678', businessId: rentals.id });
  });

  it('does not ask at all while there is a single business', async () => {
    mountSend([kepas], null);
    await screen.findByLabelText(copy.send.phone.recipient, { exact: false });
    expect(screen.queryByLabelText(copy.send.phone.business)).toBeNull();
  });
});
describe('History, narrowed by business and by customer', () => {
  it('offers a business filter once one exists and sends the choice as businessId', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url.includes('/api/businesses')) return json({ items: [kepas, rentals], lastUsedId: null });
      return json({ items: [], nextCursor: null });
    }));
    render(<MemoryRouter><History /></MemoryRouter>);
    const select = await screen.findByLabelText(copy.history.business);
    expect(within(select).getByText(copy.history.anyBusiness)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'b2' } });
    await waitFor(() => expect(urls.some((u) => u.includes('businessId=b2'))).toBe(true));
  });

  it('names the customer it was opened for and can clear that filter', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/businesses')) return json({ items: [kepas], lastUsedId: null });
      return json({ items: [], nextCursor: null });
    }));
    render(<MemoryRouter initialEntries={['/history?customer=k1&customerName=Jane%20Doe']}><History /></MemoryRouter>);
    expect(await screen.findByText(copy.history.oneCustomer('Jane Doe'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.history.clearCustomer }));
    await waitFor(() => expect(screen.queryByText(copy.history.oneCustomer('Jane Doe'))).toBeNull());
  });
});

describe('Bulk send, tagged with a business', () => {
  it('asks which business from the second one on and sends it with the batch', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = (init?.method ?? 'GET') + ' ' + String(input);
      if (key === 'GET /api/send/bulk') return json({ items: [] });
      if (key === 'GET /api/send/categories') return json({ items: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }] });
      if (key === 'GET /api/contacts?kind=phone') return json({ items: [] });
      if (key === 'GET /api/businesses') return json({ items: [kepas, rentals], lastUsedId: rentals.id });
      if (key === 'POST /api/send/bulk/check') return json({ rows: [{ line: 1, phone: '254712345678', amountCents: 1000, name: null, note: null }], errors: [], count: 1, totalCents: 1000 });
      if (key === 'POST /api/send/bulk') { posted = JSON.parse(String(init?.body)); return json({ id: 'p1', category: null, rowCount: 1, totalCents: 1000, status: 'sending', createdAt: at, finishedAt: null, createdBy: null, rows: [] }, 201); }
      throw new Error('unexpected fetch ' + key);
    }));
    render(<MemoryRouter><Bulk /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText(copy.bulk.paste), { target: { value: '0712345678,10' } });
    fireEvent.click(screen.getByRole('button', { name: copy.bulk.check }));
    // The question appears only once the list has passed its check, as the page's own flow has it.
    expect(await screen.findByLabelText(copy.bulk.business)).toHaveValue(rentals.id);
    fireEvent.click(screen.getByRole('button', { name: copy.bulk.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toMatchObject({ businessId: rentals.id }));
  });
});
const c2b = { id: 'r9', type: 'c2b', subtype: 'Pay Bill', status: 'completed', amountCents: 30000, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: 'Robert' }, remarks: null, receipt: 'RI9', category: null, contactName: null, accountReference: '999123', businessName: null, customerName: null, createdAt: at, sentAt: at, resultAt: at, resultSource: 'callback', safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null };
const moneyInView = { mode: 'production', c2bRegisteredAt: at, pullRegisteredAt: at, pullCheckedAt: null, nominatedNumber: null, publicVerified: true, registering: false, lastError: null, alreadyRegistered: false };

function mountMoneyIn(unmatched: unknown[], handlers: Handlers = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    const h = handlers[key];
    if (h) return h(init);
    if (key === 'GET /api/money-in/status') return json(moneyInView);
    if (key === 'GET /api/money-in/recent') return json({ items: [], nextCursor: null });
    if (key === 'GET /api/money-in/unmatched') return json({ items: unmatched });
    if (key === 'GET /api/businesses') return json({ items: [kepas, rentals], lastUsedId: null });
    if (key === 'GET /api/businesses/b1/customers') return json({ items: [jane] });
    throw new Error('unexpected fetch ' + key);
  }));
  render(<MemoryRouter><MoneyIn /></MemoryRouter>);
}

describe('Money in, sorting what the account number did not', () => {
  it('picks a business for a code nobody owns and assigns the payment to it', async () => {
    let posted: unknown = null;
    mountMoneyIn([{ ...c2b, reason: 'no_business', businessId: null, customerNumber: null }], {
      'POST /api/businesses/assign/r9': (init) => { posted = JSON.parse(String(init?.body)); return json(c2b); },
    });
    expect(await screen.findByText(copy.moneyIn.unmatched.noBusiness('999123'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.moneyIn.unmatched.whichBusiness), { target: { value: 'b2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.unmatched.assign }));
    await waitFor(() => expect(posted).toEqual({ businessId: 'b2', customerId: undefined }));
  });

  it('creates the customer number the payer typed, then assigns the payment to it', async () => {
    const calls: string[] = [];
    mountMoneyIn([{ ...c2b, reason: 'no_customer', businessId: 'b1', businessName: 'Kepas Hardware', customerNumber: 123 }], {
      'POST /api/businesses/b1/customers/claim': (init) => { calls.push('claim ' + String(init?.body)); return json({ ...jane, id: 'k9', number: 123, display: '123', accountNumber: '000123', name: 'Robert' }, 201); },
      'POST /api/businesses/assign/r9': (init) => { calls.push('assign ' + String(init?.body)); return json(c2b); },
    });
    expect(await screen.findByText(copy.moneyIn.unmatched.noCustomer('999123'))).toBeInTheDocument();
    // The name starts as the payer's own name from the confirmation, and may be corrected.
    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.unmatched.createCustomer(123, 'Kepas Hardware') }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(JSON.parse(calls[0]!.slice('claim '.length))).toEqual({ number: 123, name: 'Robert' });
    expect(JSON.parse(calls[1]!.slice('assign '.length))).toEqual({ businessId: 'b1', customerId: 'k9' });
  });

  it('says nothing at all when every payment found its place', async () => {
    mountMoneyIn([]);
    expect(await screen.findByText(copy.moneyIn.recent)).toBeInTheDocument();
    expect(screen.queryByText(copy.moneyIn.unmatched.title)).toBeNull();
  });
});

describe('Home, a line per business', () => {
  function mountHome(items: unknown[]) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/businesses/summary')) return json({ items });
      if (url.includes('/api/balances/latest')) return json(balance);
      if (url.includes('/api/requests')) return json({ items: [], nextCursor: null });
      return json({});
    }));
    render(<MemoryRouter><Home /></MemoryRouter>);
  }

  it('shows each business own money in and out for the day, once there are two', async () => {
    mountHome([
      { businessId: 'b1', code: '000', name: 'Kepas Hardware', inCents: 150000, outCents: 50000 },
      { businessId: 'b2', code: '001', name: 'Rentals', inCents: 0, outCents: 25000 },
    ]);
    const row = await screen.findByTestId('home-business-b1');
    expect(within(row).getByText(/Kepas Hardware/)).toBeInTheDocument();
    // The amounts sit in their own spans, so the row's whole text is the honest thing to check.
    expect(row).toHaveTextContent('KES 1,500');
    expect(row).toHaveTextContent('KES 500');
    expect(row).toHaveTextContent(copy.home.in);
    expect(row).toHaveTextContent(copy.home.out);
    expect(await screen.findByTestId('home-business-b2')).toBeInTheDocument();
  });

  it('keeps the block away while there is only one business', async () => {
    mountHome([{ businessId: 'b1', code: '000', name: 'Kepas Hardware', inCents: 150000, outCents: 50000 }]);
    expect(await screen.findByText(copy.home.recent)).toBeInTheDocument();
    expect(screen.queryByTestId('home-business-b1')).toBeNull();
  });
});
describe('Asking a customer to pay, from a saved customer', () => {
  it('fills the account reference with that customer account number', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/businesses/b1/customers')) return json({ items: [jane] });
      if (url.includes('/api/businesses')) return json({ items: [kepas], lastUsedId: null });
      return json({});
    }));
    render(<MemoryRouter><AskToPay /></MemoryRouter>);
    answer(copy.askToPay.phone, '0712345678');
    answer(copy.askToPay.amount, '1', { exact: false });
    // Now on the reference question, which carries the picker above the field.
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(jane.name) }));
    expect(screen.getByLabelText(copy.askToPay.reference)).toHaveValue('000000');
  });
});
