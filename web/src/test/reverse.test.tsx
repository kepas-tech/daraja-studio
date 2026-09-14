import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Reverse } from '../pages/Reverse';
import { Nav } from '../app/Nav';
import { copy } from '../copy/en';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  constructor() { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent); }
}
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

const RECEIPT = 'RI6BZTPXNM';
const NOT_SETTLED = 'Studio has no completed payment with that receipt. Only a payment that already settled can be reversed.';
const ALREADY_REVERSED = 'This receipt is already being reversed, or has been. A payment can only be taken back once.';

const settled = { requestId: 'b1', receipt: RECEIPT, amountCents: 100, at: '2026-09-06T11:00:05Z', type: 'b2c' };
const sent = { id: 'r9', type: 'reversal', subtype: 'TransactionReversal', status: 'sent', amountCents: 100, currency: 'KES', recipient: { kind: 'receipt', value: RECEIPT, name: null }, remarks: null, receipt: null, createdAt: '2026-09-06T11:05:00Z', sentAt: '2026-09-06T11:05:01Z', resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' } };
const completed = { ...sent, status: 'completed', receipt: RECEIPT, resultAt: '2026-09-06T11:05:05Z', resultSource: 'callback' };

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('Reverse', () => {
  it('finds the settled payment, names it, and reverses it after the password', async () => {
    let posted: unknown = null;
    const fetchMock = fetchFor({
      [`GET /api/send/reversal/${RECEIPT}`]: () => new Response(JSON.stringify(settled), { status: 200 }),
      'POST /api/send/reversal': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(sent), { status: 201 }); },
      'GET /api/requests/r9': () => new Response(JSON.stringify(completed), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Reverse /></MemoryRouter>);

    const find = screen.getByRole('button', { name: copy.reverse.find });
    expect(find).toBeDisabled();
    // The honest limit is on the screen before anything is pressed.
    expect(screen.getByText(copy.reverse.spent)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.reverse.receipt), { target: { value: 'ri6bztpxnm' } });
    fireEvent.click(find);

    // The middle step names the receipt and the amount, and warns that this cannot be undone.
    await screen.findByText(copy.reverse.found);
    expect(screen.getByText('KES 1')).toBeInTheDocument();
    expect(screen.getByText(RECEIPT)).toBeInTheDocument();
    expect(screen.getByText(copy.reverse.irreversible)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: copy.reverse.button }));
    expect(screen.getByRole('dialog')).toHaveTextContent(copy.reverse.confirmTitle('KES 1', RECEIPT));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.reverse.result.sent);
    expect(posted).toEqual({ receipt: RECEIPT, password: 'studio-pw' });

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
    es.emit('request.updated', { type: 'request.updated', payload: { id: 'r9', status: 'completed' }, at: new Date().toISOString() });
    await screen.findByText(copy.reverse.result.completed);
  });

  it('refuses a receipt that never settled before any password is asked', async () => {
    const fetchMock = fetchFor({
      'GET /api/send/reversal/RI00000000': () => new Response(JSON.stringify({ error: { code: 'not_settled', message: NOT_SETTLED } }), { status: 409 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Reverse /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.reverse.receipt), { target: { value: 'RI00000000' } });
    fireEvent.click(screen.getByRole('button', { name: copy.reverse.find }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(NOT_SETTLED);
    // Still on the first step: no dialog, nothing sent.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: copy.reverse.find })).toBeInTheDocument();
    expect(screen.queryByText(copy.reverse.found)).toBeNull();
  });

  it('an already-reversed receipt is refused in the server\'s own words', async () => {
    const fetchMock = fetchFor({
      [`GET /api/send/reversal/${RECEIPT}`]: () => new Response(JSON.stringify(settled), { status: 200 }),
      'POST /api/send/reversal': () => new Response(JSON.stringify({ error: { code: 'already_reversed', message: ALREADY_REVERSED } }), { status: 409 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Reverse /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.reverse.receipt), { target: { value: RECEIPT } });
    fireEvent.click(screen.getByRole('button', { name: copy.reverse.find }));
    await screen.findByText(copy.reverse.found);
    fireEvent.click(screen.getByRole('button', { name: copy.reverse.button }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await screen.findByText(ALREADY_REVERSED);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // The label is the ground truth (docs/MENU-PLAN.md), and the menu is where the owner sees it.
  it('no longer says Coming soon in the menu', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    const link = document.querySelector<HTMLAnchorElement>('a[href="/reverse"]')!;
    expect(within(link).queryByText('Coming soon')).not.toBeInTheDocument();
    expect(copy.nav.find((e) => e.key === 'reverse')!.available).toBe(true);
  });
});
