import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { BusinessView } from '../api/types';
import { Businesses } from '../pages/Businesses';
import { Invoices } from '../pages/Invoices';
import { Reports } from '../pages/Reports';
import { copy } from '../copy/en';
import { wordsOf } from '../businessTypes';
import { OTHER, RENTAL, SCHOOL, SHIPPED_FIXTURES } from './typeFixtures';
import { answer, next } from './questionnaire';

/**
 * Round 3, phase B: what kind of business this is.
 *
 * The kind is data the owner picks and may edit, and its words are what every screen reads: the
 * account noun on the Businesses page, the leading line on Home, the statement's name on Reports,
 * and what a kind does with invoices.
 */

const state = vi.hoisted(() => ({ mayManage: true }));
vi.mock('../app/session', () => ({
  useSession: () => ({
    status: 'ready', person: { id: 'p1', is_owner: false },
    org: { id: 'o1', name: 'Test studio', shortcode: '600999', environment: 'production' },
    modules: { off: [], menuOff: [] },
    permissions: state.mayManage ? ['businesses.manage'] : [],
    refresh: async () => {},
  }),
}));

class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => { cleanup(); state.mayManage = true; });

const at = '2026-09-17T08:00:00Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const rentalBiz: BusinessView = { id: 'b1', code: '000', name: 'White House', active: true, accountCount: 3, numbers: { width: 3, capacity: 900, used: 3 }, createdAt: at, type: RENTAL };

describe('the kind of business, on the Businesses page', () => {
  it('asks what kind it is when a business is made, and posts the kind with the name', async () => {
    let posted: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = (init?.method ?? 'GET') + ' ' + String(input);
      if (key === 'GET /api/businesses') return json({ items: [], lastUsedId: null });
      if (key === 'GET /api/business-types') return json({ items: SHIPPED_FIXTURES });
      if (key === 'POST /api/businesses') { posted = JSON.parse(String(init?.body)); return json({ ...rentalBiz, name: 'Farm', type: SCHOOL }, 201); }
      throw new Error('unexpected fetch ' + key);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Businesses /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: copy.businesses.add }));
    // The kind is asked for as part of making the business, with the hint that it can change later.
    expect(screen.getByText(copy.businesses.kindStepHint)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.businesses.name), { target: { value: 'Farm' } });
    fireEvent.change(screen.getByLabelText(copy.businesses.kindStep), { target: { value: 'school' } });
    fireEvent.click(screen.getByRole('button', { name: copy.businesses.save }));
    await waitFor(() => expect(posted).toEqual({ name: 'Farm', typeKey: 'school' }));
  });

  it('names the kind and its expectations on the row, in that kind\'s own words', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/businesses') return json({ items: [rentalBiz], lastUsedId: null });
      if (url === '/api/business-types') return json({ items: SHIPPED_FIXTURES });
      if (url === '/api/businesses/b1/accounts') return json({ items: [] });
      throw new Error('unexpected fetch ' + url);
    }));
    render(<MemoryRouter><Businesses /></MemoryRouter>);
    const row = await screen.findByTestId('business-b1');
    expect(within(row).getByTestId('kind-b1')).toHaveTextContent('Rental or property');
    expect(within(row).getByTestId('expects-b1')).toHaveTextContent('Money is expected every month.');
    expect(within(row).getByTestId('expects-b1')).toHaveTextContent('Invoices are on, with reminders.');
    const words = wordsOf(RENTAL);
    expect(within(row).getByText(copy.businesses.accountCount(3, words.one, words.many))).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: copy.businesses.accounts('Tenants') })).toBeInTheDocument();
  });

  it('changes the kind afterwards, promising that only words change', async () => {
    let put: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = (init?.method ?? 'GET') + ' ' + String(input);
      if (key === 'GET /api/businesses') return json({ items: [rentalBiz], lastUsedId: null });
      if (key === 'GET /api/business-types') return json({ items: SHIPPED_FIXTURES });
      if (key === 'PUT /api/businesses/b1/type') { put = JSON.parse(String(init?.body)); return json({ ...rentalBiz, type: SCHOOL }); }
      throw new Error('unexpected fetch ' + key);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Businesses /></MemoryRouter>);
    const row = await screen.findByTestId('business-b1');
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.changeKind }));
    expect(screen.getByText(copy.businesses.changeKindBody)).toBeInTheDocument();
    fireEvent.change(within(row).getByLabelText(copy.businesses.changeKind), { target: { value: 'school' } });
    fireEvent.click(within(row).getByRole('button', { name: copy.businesses.save }));
    await waitFor(() => expect(put).toEqual({ typeKey: 'school' }));
  });

  it('edits a kind\'s words, adds one the owner invents, and deletes one nobody uses', async () => {
    const calls: { key: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = (init?.method ?? 'GET') + ' ' + String(input);
      if (key === 'GET /api/businesses') return json({ items: [], lastUsedId: null });
      if (key === 'GET /api/business-types') return json({ items: SHIPPED_FIXTURES });
      if (key.startsWith('PUT /api/business-types/')) { calls.push({ key, body: JSON.parse(String(init?.body)) }); return json({ ...RENTAL, name: 'Rental (flats)' }); }
      if (key === 'POST /api/business-types') { calls.push({ key, body: JSON.parse(String(init?.body)) }); return json({ ...OTHER, key: 'car_wash', name: 'Car wash' }, 201); }
      if (key === 'DELETE /api/business-types/transport') { calls.push({ key, body: null }); return new Response(null, { status: 204 }); }
      throw new Error('unexpected fetch ' + key);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Businesses /></MemoryRouter>);
    // Edit the words: the nouns are free text, so a kind can read properly without a deploy.
    const rental = await screen.findByTestId('type-rental');
    fireEvent.click(within(rental).getByRole('button', { name: copy.typeWords.edit }));
    fireEvent.change(screen.getByLabelText(copy.typeWords.accountNoun), { target: { value: 'Mpangaji' } });
    fireEvent.click(screen.getByRole('button', { name: copy.typeWords.save }));
    await waitFor(() => expect(calls.length).toBe(1));
    const edited = calls[0]!.body as { name: string; template: { accountNoun: string; categories: string[] } };
    expect(edited.name).toBe('Rental or property');
    expect(edited.template.accountNoun).toBe('Mpangaji');
    expect(edited.template.categories).toEqual(['Rent', 'Deposit']);
    // Add a kind of the owner's own.
    fireEvent.click(screen.getByRole('button', { name: copy.typeWords.add }));
    fireEvent.change(screen.getByLabelText(copy.typeWords.name), { target: { value: 'Car wash' } });
    fireEvent.change(screen.getByLabelText(copy.typeWords.accountNoun), { target: { value: 'Attendant' } });
    fireEvent.change(screen.getByLabelText(copy.typeWords.statementNoun), { target: { value: 'Wash record' } });
    fireEvent.click(screen.getByRole('button', { name: copy.typeWords.save }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/business-types')).toBe(true));
    // Delete a kind nobody uses.
    fireEvent.click(within(await screen.findByTestId('type-school')).getByRole('button', { name: copy.typeWords.remove }));
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /api/business-types/transport')).toBe(false));
  });
});

describe('the kind of business, on the other screens', () => {
  it('calls Reports by the kind\'s name for the statement', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/businesses') return json({ items: [rentalBiz] });
      if (url.startsWith('/api/reports?')) return json({ window: { days: 7, from: '2026-09-11', to: '2026-09-17' }, days: [], totals: { inCents: 0, inCount: 0, outCents: 0, outCount: 0, completed: 0, failed: 0, unknown: 0 }, failures: [], byBusiness: [] });
      throw new Error('unexpected fetch ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Reports /></MemoryRouter>);
    expect(await screen.findByRole('heading', { level: 1, name: 'Rent statement' })).toBeInTheDocument();
  });

  it('says what this kind of business does with invoices when an account is picked', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = (init?.method ?? 'GET') + ' ' + String(input);
      if (key === 'GET /api/invoices/settings') return json({ mode: 'sandbox', optedIn: true, optedInAt: at, email: 'bills@kepas.example', phone: '254700000000', reminders: true, publicVerified: true });
      if (key === 'GET /api/invoices') return json({ items: [] });
      if (key === 'GET /api/businesses') return json({ items: [rentalBiz] });
      if (key === 'GET /api/businesses/b1/accounts') return json({ items: [{ id: 'k1', businessId: 'b1', parentId: null, number: '359', fullNumber: '000359', name: 'Jane Doe', phone: null, note: null, createdAt: at, previousHolder: null, children: [] }] });
      throw new Error('unexpected fetch ' + key);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: copy.invoices.new }));
    answer(copy.invoices.form.customerName, 'Jane Doe');
    next();
    answer(copy.invoices.form.customerPhone, '0700123456', { exact: false });
    next();
    answer(copy.invoices.form.invoiceName, 'September rent');
    next();
    fireEvent.click(await screen.findByRole('button', { name: /Jane Doe/ }));
    expect(await screen.findByTestId('invoice-kind')).toHaveTextContent('Rental or property');
    expect(screen.getByTestId('invoice-kind')).toHaveTextContent('Invoices are on, with reminders.');
  });
});
