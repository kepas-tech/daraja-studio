import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SendPhone } from '../pages/send/SendPhone';
import { copy } from '../copy/en';

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function GoAgain({ id }: { id: string }) {
  const navigate = useNavigate();
  return <button onClick={() => navigate(`/send/phone?again=${id}`)}>go again {id}</button>;
}

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

/**
 * Carry S6. `useEvents` opens the stream inside an effect, so under the parallel server+web run the
 * assertion below could index `instances` before React had flushed that effect and read
 * `undefined`. Wait for the instance instead of assuming it is already there.
 */
async function lastEventSource(): Promise<FakeEventSource> {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
}

const sent = { id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'sent', amountCents: 100, currency: 'KES', recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: null, receipt: null, createdAt: '2026-09-06T11:00:00Z', sentAt: '2026-09-06T11:00:01Z', resultAt: null, resultSource: null, safaricomSaid: null, meaning: null, whatToDo: null, retriable: false, pollAttempts: 0, checked: null, createdBy: { id: 'p', displayName: 'Owner' } };
const completed = { ...sent, status: 'completed', receipt: 'RI6BZTPXNM', recipient: { ...sent.recipient, name: '254700123456 - Jane Doe' }, resultAt: '2026-09-06T11:00:05Z', resultSource: 'callback' };
const balance = { workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: new Date().toISOString() };

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}
async function fillForm() {
  fireEvent.change(screen.getByLabelText(copy.send.phone.recipient, { exact: false }), { target: { value: '0700123456' } });
  fireEvent.change(screen.getByLabelText(copy.send.phone.amount, { exact: false }), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
  await screen.findByText(copy.send.phone.review.title);
}

describe('SendPhone', () => {
  it('form → review (with balance) → password → sent → live completed', async () => {
    let posted: unknown = null;
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'POST /api/send/phone': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify(sent), { status: 201 }); },
      'GET /api/requests/r1': () => new Response(JSON.stringify(completed), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    expect(screen.getByRole('button', { name: copy.send.phone.next })).toBeDisabled();
    await fillForm();
    await screen.findByText('KES 34,392');
    await screen.findByText('KES 34,391');
    expect(screen.getByText(copy.send.phone.review.nameNote)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    expect(screen.getByRole('dialog')).toHaveTextContent(copy.send.phone.confirmTitle('KES 1', '0700 123 456'));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    expect(posted).toEqual({ phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment', remarks: undefined, confirmDuplicate: undefined, password: 'studio-pw' });
    const es = await lastEventSource();
    const instancesAtSent = FakeEventSource.instances.length;
    es.emit('request.updated', { type: 'request.updated', payload: { id: 'r1', status: 'completed' }, at: new Date().toISOString() });
    await screen.findByText(copy.send.phone.result.completed);
    expect(FakeEventSource.instances.length).toBe(instancesAtSent);
    expect(screen.getByText('RI6BZTPXNM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.send.phone.result.sendAnother })).toBeInTheDocument();
  });

  it('W2: re-fetches on SSE reconnect (open) without waiting for a missed event', async () => {
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'POST /api/send/phone': () => new Response(JSON.stringify(sent), { status: 201 }),
      'GET /api/requests/r1': () => new Response(JSON.stringify(completed), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    const es = await lastEventSource();
    // No 'request.updated' event is ever emitted — only the connection's own open fires.
    es.onopen?.();
    await screen.findByText(copy.send.phone.result.completed);
  });

  it('W2: falls back to a 15s poll while a result is pending, and stops once it is not', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      const fetchMock = fetchFor({
        'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
        'POST /api/send/phone': () => new Response(JSON.stringify(sent), { status: 201 }),
        'GET /api/requests/r1': () => { calls++; return new Response(JSON.stringify(completed), { status: 200 }); },
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<MemoryRouter><SendPhone /></MemoryRouter>);
      await fillForm();
      fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
      fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
      fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
      await screen.findByText(copy.send.phone.result.sent);
      await vi.advanceTimersByTimeAsync(15_000);
      await screen.findByText(copy.send.phone.result.completed);
      expect(calls).toBe(1);
      const callsAtCompleted = calls;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(callsAtCompleted);
    } finally { vi.useRealTimers(); }
  });

  it('duplicate: 409 duplicate_recent asks, then resubmits with confirmDuplicate', async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'POST /api/send/phone': (init) => { bodies.push(JSON.parse(String(init?.body))); calls++; return calls === 1
        ? new Response(JSON.stringify({ error: { code: 'duplicate_recent', message: 'You sent this already. Send it again?', details: { requestId: 'r0', at: '2026-09-06T10:42:00Z' } } }), { status: 409 })
        : new Response(JSON.stringify(sent), { status: 201 }); },
      'GET /api/requests/r1': () => new Response(JSON.stringify(sent), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(/You sent this already at/);
    expect(bodies[0]).not.toHaveProperty('confirmDuplicate');
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.duplicateYes }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    expect((bodies[1] as { confirmDuplicate: boolean }).confirmDuplicate).toBe(true);
  });

  it('cancelling a duplicate prompt then editing and resending does not carry confirmDuplicate over', async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const resent = { ...sent, amountCents: 200 };
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'POST /api/send/phone': (init) => { bodies.push(JSON.parse(String(init?.body))); calls++; return calls === 1
        ? new Response(JSON.stringify({ error: { code: 'duplicate_recent', message: 'You sent this already. Send it again?', details: { requestId: 'r0', at: '2026-09-06T10:42:00Z' } } }), { status: 409 })
        : new Response(JSON.stringify(resent), { status: 201 }); },
      'GET /api/requests/r1': () => new Response(JSON.stringify(resent), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(/You sent this already at/);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.duplicateNo }));
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.back }));
    fireEvent.change(screen.getByLabelText(copy.send.phone.amount, { exact: false }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.title);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    expect(bodies[1]).not.toHaveProperty('confirmDuplicate');
  });

  it('a confirmed duplicate does not leak into a different payment after Back', async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'POST /api/send/phone': (init) => { bodies.push(JSON.parse(String(init?.body))); calls++; return calls === 1
        ? new Response(JSON.stringify({ error: { code: 'duplicate_recent', message: 'You sent this already. Send it again?', details: { requestId: 'r0', at: '2026-09-06T10:42:00Z' } } }), { status: 409 })
        : new Response(JSON.stringify(sent), { status: 201 }); },
      'GET /api/requests/r1': () => new Response(JSON.stringify(sent), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(/You sent this already at/);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.duplicateYes }));
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.cancel }));
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.back }));
    fireEvent.change(screen.getByLabelText(copy.send.phone.amount, { exact: false }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.title);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.sent);
    const last = bodies[bodies.length - 1] as { amountCents: number };
    expect(last.amountCents).toBe(200);
    expect(last).not.toHaveProperty('confirmDuplicate');
  });

  it('a wrong password keeps the dialog open with the server message; a short balance blocks Send', async () => {
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify({ ...balance, utilityCents: 50 }), { status: 200 }),
      'POST /api/send/phone': () => new Response(JSON.stringify({ error: { code: 'step_up_required', message: 'Enter your own password to confirm.' } }), { status: 403 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    expect(screen.getByText(copy.send.phone.review.short)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.send.phone.send })).toBeDisabled();
  });

  it('shows the cap message from the server', async () => {
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response('null', { status: 200 }),
      'POST /api/send/phone': () => new Response(JSON.stringify({ error: { code: 'over_cap', message: 'This studio is capped at KES 1 per send.', details: { capCents: 100 } } }), { status: 409 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.send.phone.recipient, { exact: false }), { target: { value: '0700123456' } });
    fireEvent.change(screen.getByLabelText(copy.send.phone.amount, { exact: false }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.balanceMissing);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText('This studio is capped at KES 1 per send.');
  });

  it('shows the send cap from /healthz on Review and disables Send above it', async () => {
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'GET /healthz': () => new Response(JSON.stringify({ sendCapCents: 100 }), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(copy.send.phone.recipient, { exact: false }), { target: { value: '0700123456' } });
    fireEvent.change(screen.getByLabelText(copy.send.phone.amount, { exact: false }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.next }));
    await screen.findByText(copy.send.phone.review.title);
    await screen.findByText(copy.send.phone.review.cap('KES 1'));
    expect(screen.getByRole('button', { name: copy.send.phone.send })).toBeDisabled();
  });

  it("W5: does not show a cap line when /healthz reports no cap, and Send stays enabled", async () => {
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'GET /healthz': () => new Response(JSON.stringify({ sendCapCents: null }), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    await screen.findByText(copy.send.phone.review.title);
    expect(screen.queryByText(/capped at/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.send.phone.send })).not.toBeDisabled();
  });

  it('a failed send explains why, offers Try again, and returns to review on retry', async () => {
    const failed = { ...sent, status: 'failed', retriable: true, safaricomSaid: 'The balance is insufficient for the transaction.', meaning: 'Utility float too low.', whatToDo: 'Move float, then send again.' };
    const fetchMock = fetchFor({
      'GET /api/balances/latest': () => new Response(JSON.stringify(balance), { status: 200 }),
      'POST /api/send/phone': () => new Response(JSON.stringify(failed), { status: 201 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><SendPhone /></MemoryRouter>);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.send }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await screen.findByText(copy.send.phone.result.failed);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(failed.safaricomSaid);
    expect(alert).toHaveTextContent(failed.meaning);
    expect(alert).toHaveTextContent(failed.whatToDo);
    fireEvent.click(screen.getByRole('button', { name: copy.request.tryAgain }));
    await screen.findByText(copy.send.phone.review.title);
  });

  it('prefills from ?again=<id> without auto-submitting, and drops the param from the URL', async () => {
    const fetchMock = fetchFor({ 'GET /api/requests/r1': () => new Response(JSON.stringify(completed), { status: 200 }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/send/phone?again=r1']}><LocationProbe /><SendPhone /></MemoryRouter>);
    await screen.findByText(copy.send.phone.review.title);
    await waitFor(() => expect(document.body.textContent).toContain('0700 123 456'));
    await waitFor(() => expect(document.body.textContent).toContain('KES 1'));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/send/phone'));
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') !== 'POST')).toBe(true);
  });

  it('shows a plain-English notice and leaves the form empty when the ?again= row cannot be loaded', async () => {
    const fetchMock = fetchFor({ 'GET /api/requests/r1': () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'That request does not exist.' } }), { status: 404 }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/send/phone?again=r1']}><LocationProbe /><SendPhone /></MemoryRouter>);
    await screen.findByText(copy.send.phone.againUnavailable);
    expect(screen.getByLabelText(copy.send.phone.recipient, { exact: false })).toHaveValue('');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/send/phone'));
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') !== 'POST')).toBe(true);
  });

  it('clears a stale "could not load" notice once a later ?again= prefill succeeds', async () => {
    const fetchMock = fetchFor({
      'GET /api/requests/r1': () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'That request does not exist.' } }), { status: 404 }),
      'GET /api/requests/r2': () => new Response(JSON.stringify(completed), { status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter initialEntries={['/send/phone?again=r1']}><GoAgain id="r2" /><SendPhone /></MemoryRouter>);
    await screen.findByText(copy.send.phone.againUnavailable);
    fireEvent.click(screen.getByRole('button', { name: 'go again r2' }));
    await screen.findByText(copy.send.phone.review.title);
    fireEvent.click(screen.getByRole('button', { name: copy.send.phone.back }));
    expect(screen.queryByText(copy.send.phone.againUnavailable)).not.toBeInTheDocument();
  });
});
