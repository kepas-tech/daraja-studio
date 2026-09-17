import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Approvals, ageOf } from '../pages/Approvals';
import { copy } from '../copy/en';
import type { RequestView, WaitingView } from '../api/types';

// The page subscribes to live events; the stream itself is not under test here.
class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
vi.mock('../app/session', () => ({ useSession: () => ({ status: 'ready', person: { id: 'anna', display_name: 'Anna', is_owner: false }, org: null, permissions: ['send.approve'], refresh: async () => {} }) }));
afterEach(() => cleanup());

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', type: 'b2c', subtype: 'BusinessPayment', status: 'sent', amountCents: 500000, currency: 'KES',
  recipient: { kind: 'phone', value: '254700123456', name: null }, remarks: null, receipt: null, category: 'Rent',
  contactName: null, accountReference: null, businessName: null, accountName: null,
  createdAt: ago(30), sentAt: ago(3.5), resultAt: null, resultSource: null, safaricomSaid: null, meaning: null,
  whatToDo: null, retriable: false, pollAttempts: 1, checked: null, createdBy: { id: 'owner', displayName: 'Amina' },
  approvedBy: null, ...over,
}) as unknown as RequestView;

const view = (over: Partial<WaitingView> = {}): WaitingView => ({
  approvals: { items: [], canDecide: true },
  sent: { items: [], count: 0 },
  noAnswer: { items: [], count: 0 },
  badge: 0,
  ...over,
});

function fetchFor(v: WaitingView) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    if (key === 'GET /api/waiting') return new Response(JSON.stringify(v), { status: 200 });
    if (key.startsWith('POST /api/requests/')) return new Response(JSON.stringify({ requestId: 'q1' }), { status: 202 });
    throw new Error(`unexpected fetch ${key}`);
  });
}

describe('the Waiting page', () => {
  it('shows the three groups with their counts, and how long each row has waited', async () => {
    vi.stubGlobal('fetch', fetchFor(view({
      approvals: { items: [row({ id: 'held1', status: 'awaiting_approval', sentAt: null, createdAt: ago(120) })], canDecide: true },
      sent: { items: [row({ id: 'sent1' })], count: 1 },
      noAnswer: { items: [row({ id: 'unknown1', status: 'unknown' })], count: 1 },
      badge: 2,
    })));
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    expect(await screen.findByRole('heading', { level: 2, name: `${copy.waiting.approvals} (1)` })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: `${copy.waiting.sent} (1)` })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: `${copy.waiting.noAnswer} (1)` })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: copy.waiting.check })).toHaveLength(2);
    expect(screen.getByRole('button', { name: copy.approvals.release })).toBeInTheDocument();
    expect(screen.getAllByText(copy.waiting.minutes(3)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(copy.waiting.hours(2)).length).toBeGreaterThan(0);
  });

  it('Check with Safaricom asks the server about that row', async () => {
    const fetchMock = fetchFor(view({ sent: { items: [row({ id: 'sent9' })], count: 1 }, badge: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: copy.waiting.check }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/requests/sent9/check', expect.objectContaining({ method: 'POST' })));
  });

  it('somebody who may not decide is told the count and is shown no Release button', async () => {
    vi.stubGlobal('fetch', fetchFor(view({
      approvals: { items: [], canDecide: false },
      noAnswer: { items: [row({ id: 'unknown2', status: 'unknown' })], count: 1 },
      badge: 2,
    })));
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    expect(await screen.findByRole('heading', { level: 2, name: `${copy.waiting.approvals} (1)` })).toBeInTheDocument();
    expect(screen.getByText(copy.waiting.cannotDecide(1))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.approvals.release })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.approvals.refuse })).toBeNull();
  });

  it('says so when nothing is waiting', async () => {
    vi.stubGlobal('fetch', fetchFor(view()));
    render(<MemoryRouter><Approvals /></MemoryRouter>);
    expect(await screen.findByText(copy.waiting.empty)).toBeInTheDocument();
  });

  it('reads an age as minutes, hours, then days', () => {
    expect(ageOf(ago(0))).toBe(copy.waiting.justNow);
    expect(ageOf(ago(7))).toBe(copy.waiting.minutes(7));
    expect(ageOf(ago(5 * 60))).toBe(copy.waiting.hours(5));
    expect(ageOf(ago(24 * 60))).toBe(copy.waiting.yesterday);
    expect(ageOf(ago(72 * 60))).toBe(copy.waiting.days(3));
  });
});
