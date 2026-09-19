import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MoneyIn } from '../pages/MoneyIn';
import { History } from '../pages/History';
import { copy } from '../copy/en';
import { when } from '../format';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
vi.mock('../app/session', () => ({ useSession: () => ({ status: 'ready', person: { id: 'p1', display_name: 'Owner', is_owner: true }, org: null, permissions: [], refresh: async () => {}, modules: { off: [], menuOff: [] } }) }));
afterEach(() => cleanup());

const status = (over: Record<string, unknown> = {}) => ({ mode: 'sandbox', c2bRegisteredAt: null, pullRegisteredAt: null, pullCheckedAt: null, nominatedNumber: '254700000000', publicVerified: true, registering: false, lastError: null, alreadyRegistered: false, ...over });
const row = { id: 'r1', type: 'c2b', subtype: 'Pay Bill', status: 'completed', amountCents: 25000, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: 'Jane Doe' }, remarks: null, receipt: 'RC00000001', category: null, createdAt: '2026-09-16T07:15:30Z', sentAt: '2026-09-16T07:15:30Z', resultAt: '2026-09-16T07:15:31Z', resultSource: 'callback', safaricomSaid: 'Completed', meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: null };

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('Money in', () => {
  it('shows not turned on, and Turn on asks for the password then posts the registration', async () => {
    let posted: unknown = null; let registering = false;
    vi.stubGlobal('fetch', fetchFor({
      // The start answers 202; the page then reads status until it settles, and here it settles as registered.
      'GET /api/money-in/status': () => new Response(JSON.stringify(registering ? status({ c2bRegisteredAt: '2026-09-16T07:00:00Z', pullRegisteredAt: '2026-09-16T07:00:00Z' }) : status()), { status: 200 }),
      'GET /api/money-in/recent': () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }),
      'POST /api/money-in/register': (init) => { posted = JSON.parse(String(init?.body)); registering = true; return new Response(JSON.stringify(status({ registering: true })), { status: 202 }); },
    }));
    render(<MemoryRouter><MoneyIn /></MemoryRouter>);
    await screen.findByText(copy.moneyIn.notRegistered);
    expect(screen.getByText(copy.moneyIn.empty)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.turnOn }));
    await screen.findByText(copy.moneyIn.confirmTurnOn);
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toEqual({ password: 'correct horse' }));
    // The page re-reads status every three seconds while Safaricom is being told.
    await screen.findByText(/On since/, {}, { timeout: 5000 });
    expect(screen.getByRole('button', { name: copy.moneyIn.turnOnAgain })).toBeInTheDocument();
  });

  it('shows Safaricom\'s refusal, line by line, when the last registration failed', async () => {
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/money-in/status': () => new Response(JSON.stringify(status({ lastError: 'Bad Request - Invalid ShortCode\nSafaricom does not know this number.\nCheck the paybill or till number in Settings.' })), { status: 200 }),
      'GET /api/money-in/recent': () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }),
    }));
    render(<MemoryRouter><MoneyIn /></MemoryRouter>);
    await screen.findByText(copy.moneyIn.failed);
    expect(screen.getByText('Bad Request - Invalid ShortCode')).toBeInTheDocument();
    expect(screen.getByText('Check the paybill or till number in Settings.')).toBeInTheDocument();
  });

  it('once on, Check for missed payments posts and reports what it found, and the latest list shows payments', async () => {
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/money-in/status': () => new Response(JSON.stringify(status({ c2bRegisteredAt: '2026-09-16T07:00:00Z', pullRegisteredAt: '2026-09-16T07:00:00Z' })), { status: 200 }),
      'GET /api/money-in/recent': () => new Response(JSON.stringify({ items: [row], nextCursor: null }), { status: 200 }),
      'POST /api/money-in/check': () => new Response(JSON.stringify({ found: 2, checkedAt: '2026-09-16T08:00:00Z' }), { status: 200 }),
    }));
    render(<MemoryRouter><MoneyIn /></MemoryRouter>);
    await screen.findByText('Jane Doe');
    expect(screen.getByText('RC00000001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.check }));
    await screen.findByText(copy.moneyIn.found(2));
  });

  it('cannot be turned on until the public address is tested', async () => {
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/money-in/status': () => new Response(JSON.stringify(status({ publicVerified: false })), { status: 200 }),
      'GET /api/money-in/recent': () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }),
    }));
    render(<MemoryRouter><MoneyIn /></MemoryRouter>);
    await screen.findByText(copy.moneyIn.needsAddress);
    expect(screen.getByRole('button', { name: copy.moneyIn.turnOn })).toBeDisabled();
  });
  // Round 4: the payer names Studio never received, asked for a few at a time.
  it('counts the payments without a name and asks Safaricom about them on one press', async () => {
    let posted = 0;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/money-in/status': () => new Response(JSON.stringify(status({ c2bRegisteredAt: '2026-09-16T07:00:00Z' })), { status: 200 }),
      'GET /api/money-in/recent': () => new Response(JSON.stringify({ items: [row], nextCursor: null }), { status: 200 }),
      'GET /api/money-in/missing-names': () => new Response(JSON.stringify({ count: posted > 0 ? 0 : 3, perRun: 5 }), { status: 200 }),
      'POST /api/money-in/find-names': () => { posted += 1; return new Response(JSON.stringify({ asked: 3, skipped: 0, remaining: 0, stopped: null }), { status: 200 }); },
    }));
    render(<MemoryRouter><MoneyIn /></MemoryRouter>);

    const card = await screen.findByTestId('missing-names');
    expect(card).toHaveTextContent(copy.moneyIn.names.count(3));
    expect(card).toHaveTextContent(copy.moneyIn.names.note);

    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.names.button }));
    expect(await screen.findByText(copy.moneyIn.names.asked(3, 0))).toBeInTheDocument();
    // The count is read again after the press: the names land as the answers arrive.
    await waitFor(() => expect(screen.getByTestId('missing-names')).toHaveTextContent(copy.moneyIn.names.count(0)));
  });
  // Round 5: the question, and the feed branch with the test that proves the path.
  it('answers where payments arrive and proves the feed with a test', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/money-in/status': () => new Response(JSON.stringify(status({ arrival: 'forwarder', lastFedAt: '2026-09-19T09:00:00Z', feedKeys: 1 })), { status: 200 }),
      'GET /api/money-in/recent': () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }),
      'GET /api/money-in/missing-names': () => new Response(JSON.stringify({ count: 0, perRun: 5 }), { status: 200 }),
      'POST /api/money-in/feed/test': () => new Response(JSON.stringify({ ok: true, said: 'The path works: TEST123456 was recorded as a fed payment. The test payment has been removed.' }), { status: 200 }),
      'POST /api/money-in/arrival': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(status({ arrival: 'studio' })), { status: 200 }); },
    }));
    render(<MemoryRouter><MoneyIn /></MemoryRouter>);

    const card = await screen.findByTestId('arrival');
    expect(card).toHaveTextContent(copy.moneyIn.arrival.title);
    expect(card).toHaveTextContent(copy.moneyIn.arrival.stateFed(when('2026-09-19T09:00:00Z')));
    expect(card).toHaveTextContent(copy.moneyIn.arrival.keys(1));
    expect(card).toHaveTextContent(copy.moneyIn.arrival.forwarderWhat);
    expect(screen.getByTestId('inbox-url')).toHaveTextContent('/api/money-in/feed');
    expect(screen.getByRole('link', { name: copy.moneyIn.arrival.makeKey })).toHaveAttribute('href', '/api-keys');
    // The sample carries Safaricom's own field names, so a forwarder can post the body untouched.
    const branch = screen.getByTestId('feed-branch');
    for (const field of ['TransactionType', 'TransID', 'TransTime', 'TransAmount', 'BusinessShortCode', 'BillRefNumber', 'MSISDN', 'FirstName']) {
      expect(branch).toHaveTextContent(field);
    }

    fireEvent.click(screen.getByRole('button', { name: copy.moneyIn.arrival.test }));
    expect(await screen.findByText(/The path works/)).toBeInTheDocument();

    // Answering the question the other way is saved: the switch the owner can change later.
    fireEvent.click(screen.getByLabelText(copy.moneyIn.arrival.studio));
    await waitFor(() => expect(posted).toEqual({ arrival: 'studio' }));
  });
});

describe('History › direction', () => {
  it('filters money in by type', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response(JSON.stringify({ items: [row], nextCursor: null }), { status: 200 }); }));
    render(<MemoryRouter><History /></MemoryRouter>);
    await screen.findByText(copy.request.type.c2b);
    fireEvent.change(screen.getByLabelText(copy.history.direction), { target: { value: 'in' } });
    // Round 3, phase A: the page sends the word; the server owns which types "money in" means.
    await waitFor(() => expect(urls.some((u) => u.includes('direction=in'))).toBe(true));
  });
});
