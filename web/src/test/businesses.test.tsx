import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import type { AccountView, BusinessView } from '../api/types';
import { AskToPay } from '../pages/AskToPay';
import { Businesses } from '../pages/Businesses';
import { Bulk } from '../pages/Bulk';
import { AccountPicker } from '../components/AccountPicker';
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
    org: { id: 'o1', name: 'Test studio', shortcode: '600999', environment: 'production' },
    permissions: state.mayManage ? ['businesses.manage'] : [],
    refresh: async () => {},
  }),
}));

// Live events are not under test here; SendPhone opens the stream once a send is on screen.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

afterEach(() => { cleanup(); state.mayManage = true; });

const at = '2026-09-17T08:00:00Z';
const kepas: BusinessView = { id: 'b1', code: '000', name: 'Kepas Hardware', active: true, accountCount: 1, numbers: { width: 3, capacity: 900, used: 1 }, createdAt: at };
const rentals: BusinessView = { id: 'b2', code: '001', name: 'Rentals', active: true, accountCount: 0, numbers: { width: 3, capacity: 900, used: 0 }, createdAt: at };
/** Jane is a customer account at 000359 with one account under her, Room 4 at 000359123. */
const room: AccountView = { id: 'k2', businessId: 'b1', parentId: 'k1', number: '123', fullNumber: '000359123', name: 'Room 4', phone: null, note: null, createdAt: at, previousHolder: null, children: [] };
const jane: AccountView = { id: 'k1', businessId: 'b1', parentId: null, number: '359', fullNumber: '000359', name: 'Jane Doe', phone: '254712345678', note: null, createdAt: at, previousHolder: null, children: [room] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Handlers = Record<string, (init?: RequestInit) => Response>;

function mountBusinesses(handlers: Handlers = {}, items: BusinessView[] = [kepas, rentals]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    const h = handlers[key];
    if (h) return h(init);
    if (key === 'GET /api/businesses') return json({ items, lastUsedId: null });
    if (key === 'GET /api/businesses/b1/accounts') return json({ items: [jane] });
    throw new Error('unexpected fetch ' + key);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><Businesses /></MemoryRouter>);
  return fetchMock;
}

describe('Businesses and their accounts', () => {
  it('lists a business with its code, its number width, and a customer whose full number is printed', async () => {
    mountBusinesses();
    const row = await screen.findByTestId('business-b1');
    expect(within(row).getByText(/Kepas Hardware/)).toBeInTheDocument();
    expect(within(row).getByText('000')).toBeInTheDocument();
    expect(within(row).getByText(copy.businesses.accountCount(1))).toBeInTheDocument();
    // The width in use, in the owner's words: 3 digits, 1 of 900 used.
    expect(within(row).getByTestId('numbers-b1')).toHaveTextContent(copy.businesses.numbersLine(3, 1, 900));

    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.accounts }));
    const customer = await screen.findByTestId('account-k1');
    expect(within(customer).getByText('Jane Doe')).toBeInTheDocument();
    expect(within(customer).getByTestId('full-k1')).toHaveTextContent('000359');
    // The owner is told what to say to the payer: the paybill, then the full account number.
    expect(within(customer).getByText(copy.businesses.tellThem('600999', '000359'))).toBeInTheDocument();
    // And the account under her is right there, printed with its own full number.
    expect(within(customer).getByText(copy.businesses.accountsUnder('Jane Doe'))).toBeInTheDocument();
    expect(within(customer).getByText(/000359123/)).toBeInTheDocument();
  });

  it('says routing is off with one business and on from the second', async () => {
    mountBusinesses({}, [kepas]);
    expect(await screen.findByText(copy.businesses.routingOff)).toBeInTheDocument();
    cleanup();
    mountBusinesses({}, [kepas, rentals]);
    expect(await screen.findByText(copy.businesses.routingOn)).toBeInTheDocument();
    expect(screen.queryByText(copy.businesses.routingOff)).toBeNull();
  });

  it('names Studio as the one who gives the code, and posts a name and nothing else', async () => {
    let posted: unknown = null;
    mountBusinesses({ 'POST /api/businesses': (init) => { posted = JSON.parse(String(init?.body)); return json({ ...rentals, id: 'b9', code: '002', name: 'Farm' }, 201); } });
    await screen.findByTestId('business-b1');
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.add }));
    expect(screen.getByText(copy.businesses.codeNext('002'))).toBeInTheDocument();
    // No code box anywhere: the code is Studio's to give, exactly like an account number.
    expect(screen.queryByLabelText(copy.businesses.code)).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.businesses.name), { target: { value: 'Farm' } });
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.save }));
    await waitFor(() => expect(posted).toEqual({ name: 'Farm' }));
  });

  it('switches a business off and on with the same route', async () => {
    const puts: unknown[] = [];
    mountBusinesses({ 'PUT /api/businesses/b1': (init) => { puts.push(JSON.parse(String(init?.body))); return json({ ...kepas, active: false }); } });
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.switchOff }));
    await waitFor(() => expect(puts).toEqual([{ name: 'Kepas Hardware', active: false }]));
  });

  it('adds a customer with a name and phone only — no form anywhere carries a number', async () => {
    let posted: unknown = null;
    mountBusinesses({
      'POST /api/businesses/b1/accounts': (init) => { posted = JSON.parse(String(init?.body)); return json({ ...jane, id: 'k9', number: '482', fullNumber: '000482', name: 'Peter', children: [] }, 201); },
      'GET /api/businesses/b1/accounts': () => json({ items: [jane, { ...jane, id: 'k9', number: '482', fullNumber: '000482', name: 'Peter', children: [] }] }),
    });
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.accounts }));
    fireEvent.click(await screen.findByRole('button', { name: copy.businesses.addCustomer }));
    // No label anywhere on the form is a number box: Studio draws the number, not the owner.
    expect(screen.queryByLabelText(/account number/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(copy.businesses.customerName), { target: { value: 'Peter' } });
    fireEvent.change(screen.getByLabelText(copy.businesses.customerPhone), { target: { value: '0712 000 001' } });
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.save }));
    await waitFor(() => expect(posted).toEqual({ name: 'Peter', phone: '254712000001', note: undefined }));
    expect(await screen.findByText('000482')).toBeInTheDocument();
  });

  it('adds an account under a customer, which the server numbers too', async () => {
    let posted: unknown = null;
    mountBusinesses({
      'POST /api/accounts/k1/sub-accounts': (init) => { posted = JSON.parse(String(init?.body)); return json({ ...room, id: 'k7', number: '482', fullNumber: '000359482', name: 'Room 7' }, 201); },
    });
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.accounts }));
    fireEvent.click(await screen.findByRole('button', { name: copy.businesses.addAccount }));
    fireEvent.change(screen.getByLabelText(copy.businesses.customerName), { target: { value: 'Room 7' } });
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.save }));
    await waitFor(() => expect(posted).toEqual({ name: 'Room 7', phone: undefined, note: undefined }));
  });

  it('deletes an account only after the exact name and the password, and sends both', async () => {
    let sent: unknown = null;
    mountBusinesses({ 'DELETE /api/accounts/k1': (init) => { sent = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); } });
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.accounts }));
    const customer = await screen.findByTestId('account-k1');
    fireEvent.click(within(customer).getAllByRole('button', { name: copy.businesses.retire })[0]!);
    // The dialog asks for the name and the password; nothing is sent until both are given.
    fireEvent.change(await screen.findByLabelText(copy.businesses.typeName('Jane Doe')), { target: { value: 'Jane Do' } });
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    expect(screen.getByRole('button', { name: copy.confirm.confirm })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(copy.businesses.typeName('Jane Doe')), { target: { value: 'Jane Doe' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(sent).toEqual({ name: 'Jane Doe', password: 'studio-pw' }));
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
  const [picked, setPicked] = useState<AccountView | null>(null);
  // The picker's own rows also print numbers, so the harness labels its copy.
  return <><AccountPicker onPick={setPicked} />{picked && <p>Picked {picked.fullNumber}</p>}</>;
}

describe('The saved-account picker', () => {
  function mountPicker() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const key = 'GET ' + String(input);
      if (key === 'GET /api/businesses') return json({ items: [kepas], lastUsedId: null });
      if (key === 'GET /api/businesses/b1/accounts') return json({ items: [jane] });
      throw new Error('unexpected fetch ' + key);
    }));
    render(<MemoryRouter><PickerHarness /></MemoryRouter>);
  }

  it('hands the page the customer whose full number the payer will type', async () => {
    mountPicker();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(jane.name) }));
    expect(await screen.findByText('Picked 000359')).toBeInTheDocument();
  });

  it('offers the accounts under a customer too, and hands back the one that was picked', async () => {
    mountPicker();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(room.name) }));
    expect(await screen.findByText('Picked 000359123')).toBeInTheDocument();
  });
});

const balance = { workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: at };
const sent = { id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'sent', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254712345678', name: null }, remarks: null, receipt: null, category: 'Business payment', contactName: null, accountName: null, createdAt: at, sentAt: at, resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null };

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
    expect(await screen.findByLabelText(copy.send.phone.business)).toHaveValue(rentals.id);
    next();
    answer(copy.send.phone.recipient, '0712345678');
    answer(copy.send.phone.amount, '1', { exact: false });
    next();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.title);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    expect(body()).toMatchObject({ phone: '0712345678', businessId: rentals.id });
  });

  it('does not ask at all while there is a single business', async () => {
    mountSend([kepas], null);
    await screen.findByLabelText(copy.send.phone.recipient, { exact: false });
    expect(screen.queryByLabelText(copy.send.phone.business)).toBeNull();
  });
});

describe('History, narrowed by business and by account', () => {
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

  it('names the account it was opened for and can clear that filter', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url);
      if (url.includes('/api/businesses')) return json({ items: [kepas], lastUsedId: null });
      return json({ items: [], nextCursor: null });
    }));
    render(<MemoryRouter initialEntries={['/history?account=k1&accountName=Jane%20Doe']}><History /></MemoryRouter>);
    expect(await screen.findByText(copy.history.oneAccount('Jane Doe'))).toBeInTheDocument();
    await waitFor(() => expect(urls.some((u) => u.includes('accountId=k1'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: copy.history.clearAccount }));
    await waitFor(() => expect(screen.queryByText(copy.history.oneAccount('Jane Doe'))).toBeNull());
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
    expect(await screen.findByLabelText(copy.bulk.business)).toHaveValue(rentals.id);
    fireEvent.click(screen.getByRole('button', { name: copy.bulk.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toMatchObject({ businessId: rentals.id }));
  });
});

const c2b = { id: 'r9', type: 'c2b', subtype: 'Pay Bill', status: 'completed', amountCents: 30000, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: 'Robert' }, remarks: null, receipt: 'RI9', category: null, contactName: null, accountReference: '999123', businessName: null, accountName: null, createdAt: at, sentAt: at, resultAt: at, resultSource: 'callback', safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null };
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
    if (key === 'GET /api/businesses/b1/accounts') return json({ items: [jane] });
    throw new Error('unexpected fetch ' + key);
  }));
  render(<MemoryRouter><MoneyIn /></MemoryRouter>);
}

describe('Money in, sorting what the account number did not', () => {
  it('picks a business for a code nobody owns and assigns the payment to it', async () => {
    let posted: unknown = null;
    mountMoneyIn([{ ...c2b, reason: 'no_business', businessId: null, customerName: null }], {
      'POST /api/businesses/assign/r9': (init) => { posted = JSON.parse(String(init?.body)); return json(c2b); },
    });
    expect(await screen.findByText(copy.moneyIn.unmatched.noBusiness('999123'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.moneyIn.unmatched.whichBusiness), { target: { value: 'b2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.unmatched.assign }));
    await waitFor(() => expect(posted).toEqual({ businessId: 'b2', accountId: undefined }));
  });

  it('says which customer has no such account, and labels the payment with one that exists', async () => {
    let posted: unknown = null;
    mountMoneyIn([{ ...c2b, reason: 'no_sub', businessId: 'b1', businessName: 'Kepas Hardware', accountName: 'Jane Doe' }], {
      'POST /api/businesses/assign/r9': (init) => { posted = JSON.parse(String(init?.body)); return json(c2b); },
    });
    expect(await screen.findByText(copy.moneyIn.unmatched.noSub('999123', 'Jane Doe'))).toBeInTheDocument();
    // The account the payment should carry is picked, never typed: Studio owns every number. The
    // list arrives with its own fetch, so wait for the account under Jane to be there to pick.
    await screen.findByRole('option', { name: /Room 4/ });
    fireEvent.change(screen.getByLabelText(copy.moneyIn.unmatched.orExisting), { target: { value: 'k2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.unmatched.assign }));
    await waitFor(() => expect(posted).toEqual({ businessId: 'b1', accountId: 'k2' }));
  });

  it('adds a customer in that business and labels the payment with the account Studio just made', async () => {
    const calls: string[] = [];
    mountMoneyIn([{ ...c2b, reason: 'no_account', businessId: 'b1', businessName: 'Kepas Hardware', customerName: null }], {
      'POST /api/businesses/b1/accounts': (init) => { calls.push('create ' + String(init?.body)); return json({ ...jane, id: 'k9', number: '482', fullNumber: '000482', name: 'Robert', children: [] }, 201); },
      'POST /api/businesses/assign/r9': (init) => { calls.push('assign ' + String(init?.body)); return json(c2b); },
    });
    expect(await screen.findByText(copy.moneyIn.unmatched.noAccount('999123'))).toBeInTheDocument();
    // The name starts as the payer's own name from the confirmation, and may be corrected.
    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.unmatched.addCustomer('Kepas Hardware') }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(JSON.parse(calls[0]!.slice('create '.length))).toEqual({ name: 'Robert' });
    expect(JSON.parse(calls[1]!.slice('assign '.length))).toEqual({ businessId: 'b1', accountId: 'k9' });
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

describe('Asking a customer to pay, from a saved account', () => {
  it('fills the account reference with the full number of the account that was picked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/businesses/b1/accounts')) return json({ items: [jane] });
      if (url.includes('/api/businesses')) return json({ items: [kepas], lastUsedId: null });
      return json({});
    }));
    render(<MemoryRouter><AskToPay /></MemoryRouter>);
    answer(copy.askToPay.phone, '0712345678');
    answer(copy.askToPay.amount, '1', { exact: false });
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(room.name) }));
    expect(screen.getByLabelText(copy.askToPay.reference)).toHaveValue('000359123');
  });
});
