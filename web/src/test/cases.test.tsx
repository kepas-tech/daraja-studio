import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RequestDetail } from '../pages/RequestDetail';
import { SessionProvider } from '../app/session';
import { copy } from '../copy/en';

class FakeEventSource { static instances: FakeEventSource[] = []; listeners: Record<string, EventListener[]> = {}; onopen: (() => void) | null = null; constructor() { FakeEventSource.instances.push(this); } addEventListener(t: string, cb: EventListener) { (this.listeners[t] ??= []).push(cb); } close() {} emit(t: string, d: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(d) } as MessageEvent); } }
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

/** Round 3, phase D-5: the case file on a payment that went wrong. */
const failed = { id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'failed', amountCents: 10000, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: 'Jane Doe' }, party: { name: 'Jane Doe', number: '254700123456', savedName: null }, direction: 'out', remarks: null, receipt: null, createdAt: '2026-09-18T09:00:00Z', sentAt: '2026-09-18T09:00:01Z', resultAt: '2026-09-18T09:05:00Z', resultSource: 'callback', safaricomSaid: 'The balance is insufficient.', meaning: 'Utility float too low.', whatToDo: 'Move float, then try again.', retriable: true, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' } };
const openCase = (over: Record<string, unknown> = {}) => ({ id: 'k1', requestId: 'r1', title: 'Customer says it never arrived', status: 'open', openedAt: '2026-09-18T10:00:00Z', openedBy: { id: 'p', displayName: 'Owner' }, closedAt: null, closedBy: null, outcome: null, notes: [], ...over });
const me = (permissions: string[], isOwner = false) => ({ person: { id: 'p', username: 'owner', display_name: 'Owner', is_owner: isOwner, must_change_password: false }, csrf: 'c', permissions, org: { id: 'o', name: 'APIONE', status: 'verified', environment: 'sandbox', isHost: true, suspendReason: null } });

function mount(handlers: Record<string, (init?: RequestInit) => Response>, permissions: string[] = ['lookup.view', 'cases.manage'], isOwner = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    if (key === 'GET /api/setup/status') return new Response(JSON.stringify({ needsOwner: false, completed: true, step: null }), { status: 200 });
    if (key === 'GET /api/auth/me') return new Response(JSON.stringify(me(permissions, isOwner)), { status: 200 });
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter initialEntries={['/requests/r1']}><SessionProvider><Routes><Route path="/requests/:id" element={<RequestDetail />} /></Routes></SessionProvider></MemoryRouter>);
  return fetchMock;
}

describe('the case file on a payment (phase D-5)', () => {
  it('opens a case, records what was done, and closes it with how it ended', async () => {
    let opened: unknown = null; let noted: unknown = null; let closed: unknown = null;
    mount({
      'GET /api/requests/r1': () => new Response(JSON.stringify(failed), { status: 200 }),
      'GET /api/requests/r1/case': () => new Response('null', { status: 200 }),
      'POST /api/requests/r1/case': (init) => { opened = JSON.parse(String(init?.body)); return new Response(JSON.stringify(openCase()), { status: 201 }); },
      'POST /api/cases/k1/notes': (init) => { noted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(openCase({ notes: [{ id: 'n1', note: 'Rang the customer.', at: '2026-09-18T11:00:00Z', by: { id: 'p', displayName: 'Owner' } }] })), { status: 200 }); },
      'POST /api/cases/k1/close': (init) => { closed = JSON.parse(String(init?.body)); return new Response(JSON.stringify(openCase({ status: 'closed', outcome: 'Paid again.', closedAt: '2026-09-18T12:00:00Z', closedBy: { id: 'p', displayName: 'Owner' }, notes: [{ id: 'n1', note: 'Rang the customer.', at: '2026-09-18T11:00:00Z', by: { id: 'p', displayName: 'Owner' } }] })), { status: 200 }); },
    });
    await screen.findByText(copy.caseFile.intro);
    fireEvent.change(screen.getByLabelText(copy.caseFile.what), { target: { value: 'Customer says it never arrived' } });
    fireEvent.click(screen.getByRole('button', { name: copy.caseFile.open }));
    expect(await screen.findByText('Customer says it never arrived')).toBeInTheDocument();
    expect(opened).toEqual({ title: 'Customer says it never arrived' });
    expect(screen.getByText(copy.caseFile.openStatus)).toBeInTheDocument();
    expect(screen.getByText(copy.caseFile.noNotes)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(copy.caseFile.note), { target: { value: 'Rang the customer.' } });
    fireEvent.click(screen.getByRole('button', { name: copy.caseFile.addNote }));
    expect(await screen.findByText('Rang the customer.')).toBeInTheDocument();
    expect(noted).toEqual({ note: 'Rang the customer.' });

    fireEvent.change(screen.getByLabelText(copy.caseFile.outcome), { target: { value: 'Paid again.' } });
    fireEvent.click(screen.getByRole('button', { name: copy.caseFile.close }));
    expect(await screen.findByText(copy.caseFile.closedStatus)).toBeInTheDocument();
    expect(closed).toEqual({ outcome: 'Paid again.' });
    expect(screen.getByText(copy.caseFile.closedNote, { exact: false })).toBeInTheDocument();
    // A closed case takes nothing more: both writing controls are gone.
    expect(screen.queryByLabelText(copy.caseFile.note)).toBeNull();
    expect(screen.queryByRole('button', { name: copy.caseFile.close })).toBeNull();
  });

  it('shows the case to somebody who may not run it, without the controls', async () => {
    mount({
      'GET /api/requests/r1': () => new Response(JSON.stringify(failed), { status: 200 }),
      'GET /api/requests/r1/case': () => new Response(JSON.stringify(openCase({ notes: [{ id: 'n1', note: 'Rang the customer.', at: '2026-09-18T11:00:00Z', by: { id: 'p', displayName: 'Owner' } }] })), { status: 200 }),
    }, ['lookup.view']);
    await screen.findByText('Customer says it never arrived');
    expect(screen.getByText('Rang the customer.')).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.caseFile.note)).toBeNull();
    expect(screen.queryByLabelText(copy.caseFile.what)).toBeNull();
    expect(screen.queryByRole('button', { name: copy.caseFile.close })).toBeNull();
  });
});
