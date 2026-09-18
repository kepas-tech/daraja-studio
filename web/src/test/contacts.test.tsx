import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ContactView } from '../api/types';
import { Contacts } from '../pages/Contacts';
import { History } from '../pages/History';
import { SendPhone } from '../pages/send/SendPhone';
import { copy } from '../copy/en';
import { answer, next } from './questionnaire';

const state = vi.hoisted(() => ({ mayManage: true }));
vi.mock('../app/session', () => ({ useSession: () => ({ status: 'ready', person: { id: 'p1', is_owner: false }, org: null, permissions: state.mayManage ? ['contacts.manage'] : [], refresh: async () => {} }) }));

// Live events are not under test; the Send page opens the stream once a send is on screen.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

afterEach(() => { cleanup(); state.mayManage = true; });

const at = '2026-09-16T08:00:00Z';
const jane: ContactView = { id: 'c1', kind: 'phone', name: 'Jane Doe', phone: '254712345678', shortcode: null, accountReference: null, note: null, createdAt: at };
const shop: ContactView = { id: 'c2', kind: 'till', name: 'Corner Shop', phone: null, shortcode: '400200', accountReference: null, note: 'Milk and bread', createdAt: at };
const power: ContactView = { id: 'c3', kind: 'paybill', name: 'KPLC', phone: null, shortcode: '888880', accountReference: 'ACC1', note: null, createdAt: at };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mountContacts(handlers: Record<string, (init?: RequestInit) => Response> = {}, listed: ContactView[] = [jane, shop, power]) {
  let list = listed;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    const h = handlers[key];
    if (h) return h(init);
    if (key === 'GET /api/contacts') return json({ items: list });
    throw new Error('unexpected fetch ' + key);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><Contacts /></MemoryRouter>);
  return { fetchMock, setList: (l: ContactView[]) => { list = l; } };
}

describe('Contacts', () => {
  it('shows the three tabs and the chosen tab own contacts, with a phone number in the usual form', async () => {
    mountContacts();
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('0712 345 678')).toBeInTheDocument();
    for (const k of ['phone', 'till', 'paybill']) expect(screen.getByLabelText(copy.contacts.tabs[k]!)).toBeInTheDocument();
    // The phone tab is the one that can be paid; a till row has no Pay and says so.
    expect(screen.queryByText('Corner Shop')).toBeNull();
    fireEvent.click(screen.getByLabelText(copy.contacts.tabs.till));
    expect(await screen.findByText('Corner Shop')).toBeInTheDocument();
    expect(screen.getByText('400200')).toBeInTheDocument();
    expect(screen.getByText('Milk and bread')).toBeInTheDocument();
    expect(screen.getByText(copy.contacts.sendNotBuilt)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.contacts.pay })).toBeNull();
    fireEvent.click(screen.getByLabelText(copy.contacts.tabs.paybill));
    expect(await screen.findByText('KPLC')).toBeInTheDocument();
    expect(screen.getByText('888880 · ACC1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.contacts.pay })).toBeNull();
    fireEvent.click(screen.getByLabelText(copy.contacts.tabs.phone));
    expect(screen.getByRole('link', { name: copy.contacts.pay })).toHaveAttribute('href', '/send/phone?contact=c1');
  });

  it('adds a phone contact, sending the number as typed and a field only for its own kind', async () => {
    let posted: unknown = null;
    const t = mountContacts({
      'POST /api/contacts': (init) => { posted = JSON.parse(String(init?.body)); return json({ ...jane, id: 'c9', name: 'Aisha', phone: '254712000111' }, 201); },
    });
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('button', { name: copy.contacts.add }));
    answer(copy.contacts.name, 'Aisha');
    answer(copy.contacts.phone, '0712 000 111');
    t.setList([jane, shop, power, { ...jane, id: 'c9', name: 'Aisha', phone: '254712000111' }]);
    fireEvent.click(screen.getByRole('button', { name: copy.contacts.save }));
    expect(await screen.findByText('Aisha')).toBeInTheDocument();
    expect(posted).toEqual({ kind: 'phone', name: 'Aisha', phone: '0712 000 111', note: undefined });
  });

  it('shows the server refusal when the name is already taken', async () => {
    mountContacts({ 'POST /api/contacts': () => json({ error: { code: 'name_taken', message: 'You already have a contact called Jane Doe.' } }, 409) });
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('button', { name: copy.contacts.add }));
    answer(copy.contacts.name, 'Jane Doe');
    answer(copy.contacts.phone, '0712 000 111');
    fireEvent.click(screen.getByRole('button', { name: copy.contacts.save }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a contact called Jane Doe.');
  });

  it('edits a contact in place, then deletes it with the DELETE route', async () => {
    let put: unknown = null;
    let deleted = 0;
    const t = mountContacts({
      'PUT /api/contacts/c2': (init) => { put = JSON.parse(String(init?.body)); return json({ ...shop, name: 'Corner Shop Ltd' }); },
      'DELETE /api/contacts/c2': () => { deleted += 1; return new Response(null, { status: 204 }); },
    });
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByLabelText(copy.contacts.tabs.till));
    fireEvent.click(within(await screen.findByTestId('contact-c2')).getByRole('button', { name: copy.contacts.edit }));
    answer(copy.contacts.name, 'Corner Shop Ltd');
    next();
    t.setList([jane, { ...shop, name: 'Corner Shop Ltd' }, power]);
    fireEvent.click(screen.getByRole('button', { name: copy.contacts.save }));
    expect(await screen.findByText('Corner Shop Ltd')).toBeInTheDocument();
    expect(put).toEqual({ kind: 'till', name: 'Corner Shop Ltd', shortcode: '400200', accountReference: undefined, note: 'Milk and bread' });

    t.setList([jane, power]);
    fireEvent.click(within(await screen.findByTestId('contact-c2')).getByRole('button', { name: copy.contacts.remove }));
    await waitFor(() => expect(deleted).toBe(1));
    await waitFor(() => expect(screen.queryByText('Corner Shop Ltd')).toBeNull());
    expect(await screen.findByText(copy.contacts.empty)).toBeInTheDocument();
  });

  it('keeps the list readable but hides every write without the permission', async () => {
    state.mayManage = false;
    mountContacts();
    await screen.findByText('Jane Doe');
    expect(screen.queryByRole('button', { name: copy.contacts.add })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.contacts.edit })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.contacts.remove })).toBeNull();
    expect(screen.getByText(copy.contacts.noManage)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.contacts.pay })).toHaveAttribute('href', '/send/phone?contact=c1');
  });
});

const balance = { workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: '2026-09-16T08:00:00Z' };
const sent = { id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'sent', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254712345678', name: null }, remarks: null, receipt: null, category: 'Business payment', contactName: 'Jane Doe', createdAt: at, sentAt: at, resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p1', displayName: 'Owner' } };

function renderSendPhone(handlers: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    const h = handlers[key];
    if (h) return h(init);
    if (key === 'GET /api/contacts?kind=phone') return json({ items: [jane] });
    if (key === 'GET /api/send/categories') return json({ items: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }] });
    if (key === 'GET /api/balances/latest') return json(balance);
    if (key === 'POST /api/send/name-check') return json({ available: false, reason: 'not_enabled', said: null });
    throw new Error('unexpected fetch ' + key);
  }));
  render(<MemoryRouter><SendPhone /></MemoryRouter>);
}

describe('Send money to a phone, from a saved contact', () => {
  it('picks a name, fills the number, and the send carries the contact id', async () => {
    let posted: unknown = null;
    renderSendPhone({ 'POST /api/send/phone': (init) => { posted = JSON.parse(String(init?.body)); return json(sent, 201); } });
    fireEvent.change(await screen.findByLabelText(copy.send.phone.fromContacts.label), { target: { value: 'c1' } });
    expect(screen.getByLabelText(copy.send.phone.recipient, { exact: false })).toHaveValue('254712345678');
    next();
    answer(copy.send.phone.amount, '1', { exact: false });
    next();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.title);
    expect(screen.getByText(copy.send.phone.fromContacts.saved('Jane Doe'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    expect(posted).toMatchObject({ phone: '254712345678', contactId: 'c1' });
  });

  it('typing a different number drops the saved contact from the send', async () => {
    let posted: unknown = null;
    renderSendPhone({ 'POST /api/send/phone': (init) => { posted = JSON.parse(String(init?.body)); return json(sent, 201); } });
    fireEvent.change(await screen.findByLabelText(copy.send.phone.fromContacts.label), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText(copy.send.phone.recipient, { exact: false }), { target: { value: '0700000000' } });
    next();
    answer(copy.send.phone.amount, '1', { exact: false });
    next();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.title);
    expect(screen.queryByText(copy.send.phone.fromContacts.saved('Jane Doe'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    expect(posted).toMatchObject({ phone: '0700000000' });
    expect(posted).not.toHaveProperty('contactId');
  });

  it('a ?contact= link from the Contacts page fills the number and the picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const key = 'GET ' + String(input);
      if (key === 'GET /api/contacts?kind=phone') return json({ items: [jane] });
      if (key === 'GET /api/send/categories') return json({ items: [{ id: 'business', name: 'Business payment', commandId: 'BusinessPayment' }] });
      throw new Error('unexpected fetch ' + key);
    }));
    render(<MemoryRouter initialEntries={['/send/phone?contact=c1']}><SendPhone /></MemoryRouter>);
    await waitFor(() => expect(screen.getByLabelText(copy.send.phone.recipient, { exact: false })).toHaveValue('254712345678'));
    expect(screen.getByLabelText(copy.send.phone.fromContacts.label)).toHaveValue('c1');
  });
});

describe('History and the saved contact', () => {
  const row = (id: string, contactName: string | null, recipientName: string | null) => ({ id, type: 'b2c', subtype: 'BusinessPayment', status: 'completed', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: recipientName }, remarks: null, contactName, receipt: 'RI' + id, category: null, createdAt: at, sentAt: at, resultAt: at, resultSource: 'callback', safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p1', displayName: 'Owner' } });

  // Round 3, phase A: the saved contact no longer hides Safaricom's own name. Both are shown when
  // they differ, because that mismatch is exactly what a person needs to see.
  it('shows both names when the saved contact differs from the name Safaricom returned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: [row('1', 'Jane Doe', 'JANE D****** O******'), row('2', null, 'PETER M******')], nextCursor: null })));
    render(<MemoryRouter><History /></MemoryRouter>);
    expect(await screen.findByText('JANE D****** O******')).toBeInTheDocument();
    expect(screen.getByText(copy.request.savedAs('Jane Doe'))).toBeInTheDocument();
    expect(screen.getByText('PETER M******')).toBeInTheDocument();
  });
});
