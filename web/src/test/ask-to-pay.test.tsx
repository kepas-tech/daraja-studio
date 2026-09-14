import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AskToPay } from '../pages/AskToPay';
import { copy } from '../copy/en';
import { answer } from './questionnaire';

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

async function lastEventSource(): Promise<FakeEventSource> {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
}

const asked = { id: 'k1', type: 'stk', subtype: null, status: 'sent', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: 'INV-7', receipt: null, createdAt: '2026-09-14T11:00:00Z', sentAt: '2026-09-14T11:00:01Z', resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' } };
const paid = { ...asked, status: 'completed', receipt: 'RI6BZTPXNM', resultAt: '2026-09-14T11:00:30Z', resultSource: 'callback' };

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

async function fillForm(reference = 'INV-7') {
  answer(copy.askToPay.phone, '0700123456', { exact: false });
  answer(copy.askToPay.amount, '1', { exact: false });
  answer(copy.askToPay.reference, reference, { exact: false });
  fireEvent.click(screen.getByRole('button', { name: copy.askToPay.next }));
  await screen.findByText(copy.askToPay.review.title);
}

describe('AskToPay', () => {
  it('form → review → asked → live paid, and never asks for a password', async () => {
    let posted: unknown = null;
    const fetchMock = fetchFor({
      'POST /api/collect/stk': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(asked), { status: 201 }); },
      'GET /api/requests/k1': () => new Response(JSON.stringify(paid), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AskToPay /></MemoryRouter>);

    expect(screen.getByRole('button', { name: copy.questionnaire.next })).toBeDisabled();
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.askToPay.ask }));
    await screen.findByText(copy.askToPay.result.sent);

    // Nothing leaves this organisation's accounts, so there is no step-up dialog to answer.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posted).toEqual({ phone: '0700123456', amountCents: 100, accountReference: 'INV-7', description: undefined, confirmDuplicate: undefined });

    const es = await lastEventSource();
    es.emit('request.updated', { type: 'request.updated', payload: { id: 'k1', status: 'completed' }, at: new Date().toISOString() });
    await screen.findByText(copy.askToPay.result.completed);
    expect(screen.getByText('RI6BZTPXNM')).toBeInTheDocument();
  });

  it('a reference is required before the customer can be asked', async () => {
    vi.stubGlobal('fetch', fetchFor({}));
    render(<MemoryRouter><AskToPay /></MemoryRouter>);
    answer(copy.askToPay.phone, '0700123456', { exact: false });
    answer(copy.askToPay.amount, '1', { exact: false });
    expect(screen.getByRole('button', { name: copy.questionnaire.next })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(copy.askToPay.reference, { exact: false }), { target: { value: 'INV-7' } });
    expect(screen.getByRole('button', { name: copy.questionnaire.next })).toBeEnabled();
  });

  it('asked twice: the repeat is refused until it is confirmed, and confirming sends it', async () => {
    const bodies: unknown[] = [];
    let call = 0;
    const fetchMock = fetchFor({
      'POST /api/collect/stk': (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        call += 1;
        return call === 1
          ? new Response(JSON.stringify({ error: { code: 'duplicate_recent', message: 'You asked for this already. Ask again?', details: { requestId: 'k0', at: '2026-09-14T10:59:00Z' } } }), { status: 409 })
          : new Response(JSON.stringify(asked), { status: 201 });
      },
      'GET /api/requests/k1': () => new Response(JSON.stringify(asked), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AskToPay /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.askToPay.ask }));

    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent('Ask again?');
    fireEvent.click(screen.getByRole('button', { name: copy.askToPay.duplicateYes }));
    await screen.findByText(copy.askToPay.result.sent);
    expect((bodies[1] as { confirmDuplicate: boolean }).confirmDuplicate).toBe(true);
  });

  it('refused by the customer: the three lines are shown, never merged', async () => {
    const refused = { ...asked, status: 'failed', safaricomSaid: 'Request cancelled by user', meaning: 'The customer dismissed the prompt.', whatToDo: 'Ask them again when they are ready.' };
    vi.stubGlobal('fetch', fetchFor({
      'POST /api/collect/stk': () => new Response(JSON.stringify(refused), { status: 201 }),
      'GET /api/requests/k1': () => new Response(JSON.stringify(refused), { status: 200 }),
    }));
    render(<MemoryRouter><AskToPay /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.askToPay.ask }));
    await screen.findByText(copy.askToPay.result.failed);
    expect(screen.getByText('Request cancelled by user')).toBeInTheDocument();
    expect(screen.getByText('The customer dismissed the prompt.')).toBeInTheDocument();
    expect(screen.getByText('Ask them again when they are ready.')).toBeInTheDocument();
  });

  it('no answer yet: the row is held, and the operator is pointed at the check rather than asked again', async () => {
    const held = { ...asked, status: 'unknown', meaning: 'We could not confirm Safaricom received this. Studio will check.' };
    vi.stubGlobal('fetch', fetchFor({
      'POST /api/collect/stk': () => new Response(JSON.stringify(held), { status: 201 }),
      'GET /api/requests/k1': () => new Response(JSON.stringify(held), { status: 200 }),
    }));
    render(<MemoryRouter><AskToPay /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.askToPay.ask }));
    await screen.findByText(copy.askToPay.result.unknown);
    expect(screen.queryByRole('button', { name: copy.askToPay.result.askAnother })).toBeNull();
    expect(screen.getByRole('link', { name: copy.request.markChecked })).toBeInTheDocument();
  });
});
