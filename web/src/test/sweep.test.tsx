import { render, screen, within, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Sweep } from '../pages/Sweep';
import { copy } from '../copy/en';

/**
 * Step three of nine: the Sweep-through page. What is owed sits beside the payments that make it
 * up, the reason nothing has left is the server's own sentence, setting it up asks for the
 * password, and stopping is one press.
 */
vi.mock('../app/session', () => ({
  useSession: () => ({
    status: 'ready', person: { id: 'p1', display_name: 'Owner', is_owner: true }, org: null,
    permissions: [], pinSet: false, modules: { off: [], menuOff: [] }, refresh: async () => {},
  }),
}));
afterEach(() => cleanup());

const c = copy.sweepPage;

const sweep = (over: Partial<import('../api/types').SweepRow> = {}) => ({
  id: 's1', window: 'daily:2026-09-18', schedule: 'daily' as const, state: 'sent' as const,
  grossCents: 100000, feeCents: 3500, netCents: 96500,
  destinationPhone: '254712345678', reasonCode: null, reason: null, gapCents: null,
  requestId: 'q1', requestStatus: 'completed', receipt: 'RI123',
  sentAt: '2026-09-18T20:00:00.000Z', createdAt: '2026-09-18T20:00:00.000Z', payments: [], ...over,
});

/** Two businesses: one sweeping and short of float, one with no phone at all. */
const list = () => ({
  minCents: 1000,
  items: [
    {
      businessId: 'b1', businessName: 'Kilimani Flats', businessCode: '010', active: true,
      destinationPhone: '254712345678', schedule: 'daily' as const, hour: 20, weekday: 1,
      fee: { percentBp: 250, flatCents: 1000, floorCents: null, ceilingCents: null },
      stopped: false, consentedAt: '2026-09-18T10:00:00.000Z', timetable: 'every day at 20:00',
      owed: {
        paidInCents: 250000, sweptCents: 100000, feesTakenCents: 3500, owedCents: 150000,
        payments: [{ id: 'r1', receipt: 'R1', amountCents: 150000, at: '2026-09-19T09:00:00.000Z', accountNumber: '010359', type: 'c2b' }],
      },
      minCents: 1000,
      waiting: { code: 'float_short', text: 'KES 100 short of the float, so the whole sweep was held and nothing was sent.', gapCents: 10000 },
      sweeps: [sweep()],
    },
    {
      businessId: 'b2', businessName: 'Mwangaza Salon', businessCode: '011', active: true,
      destinationPhone: null, schedule: 'arrival' as const, hour: 20, weekday: 1,
      fee: { percentBp: 0, flatCents: 0, floorCents: null, ceilingCents: null },
      stopped: false, consentedAt: null, timetable: 'as soon as it arrives',
      owed: {
        paidInCents: 150000, sweptCents: 0, feesTakenCents: 0, owedCents: 150000,
        payments: [{ id: 'r2', receipt: 'R2', amountCents: 150000, at: '2026-09-19T09:30:00.000Z', accountNumber: '011359', type: 'c2b' }],
      },
      minCents: 1000, waiting: { code: 'no_destination', text: 'No phone yet, so nothing is swept.', gapCents: null }, sweeps: [],
    },
  ],
});

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = (init?.method ?? 'GET') + ' ' + String(input);
    const h = handlers[key];
    if (!h) throw new Error('unexpected fetch ' + key);
    return h(init);
  });
}

describe('Sweep-through', () => {
  it('shows what is owed beside the payments behind it, why nothing left, and each sweep with its receipt', async () => {
    vi.stubGlobal('fetch', fetchFor({ 'GET /api/sweep': () => new Response(JSON.stringify(list()), { status: 200 }) }));
    render(<MemoryRouter><Sweep /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: /Kilimani Flats/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(c.title);

    // The figure, the payments that make it up, and the sum behind both.
    const owed = screen.getByTestId('owed-b1');
    expect(owed).toHaveTextContent(c.owedTitle + ': KES 1,500');
    expect(owed).toHaveTextContent('R1');
    expect(owed).toHaveTextContent('010359');
    expect(owed).toHaveTextContent(c.owedFrom(1));
    expect(owed).toHaveTextContent(c.paidIn + ': KES 2,500');
    expect(owed).toHaveTextContent(c.alreadySent + ': KES 1,000');
    expect(owed).toHaveTextContent(c.feesTaken + ': KES 35');
    expect(owed).toHaveTextContent(c.minimumLine('KES 10'));

    // The server's own sentence for why nothing has left, printed as it wrote it.
    expect(screen.getByTestId('waiting-b1')).toHaveTextContent('KES 100 short of the float, so the whole sweep was held and nothing was sent.');
    // Where it goes, when, and what is kept.
    expect(screen.getByText(c.goesTo + ': 0712 345 678')).toBeInTheDocument();
    expect(screen.getByText(c.everyWhen + ': every day at 20:00')).toBeInTheDocument();
    expect(screen.getByText(c.feeLabel + ': 2.5% plus KES 10')).toBeInTheDocument();
    // The sweep itself, with the receipt the business can check.
    expect(screen.getByTestId('sweep-row-s1')).toHaveTextContent(c.state.sent!);
    expect(screen.getByTestId('sweep-row-s1')).toHaveTextContent('KES 965 sent, KES 35 kept');
    expect(screen.getByTestId('sweep-row-s1')).toHaveTextContent(c.receipt('RI123'));
    // A business with no phone says so, and offers to set one up.
    expect(screen.getByTestId('sweep-b2')).toHaveTextContent(c.noPhone);
  });

  it('says plainly what agreeing means, and asks for the password before it changes where money goes', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/sweep': () => new Response(JSON.stringify(list()), { status: 200 }),
      'POST /api/sweep/b2': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        const next = list();
        return new Response(JSON.stringify({ ...next.items[1], destinationPhone: '254712345678', schedule: 'daily', hour: 9, consentedAt: '2026-09-19T10:00:00.000Z' }), { status: 200 });
      },
    }));
    render(<MemoryRouter><Sweep /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Mwangaza Salon/ });

    // The form opens on the business with no phone, carrying the consent sentence and the preview.
    fireEvent.click(within(screen.getByTestId('sweep-b2')).getByRole('button', { name: c.setUp }));
    expect(screen.getByText(c.consent)).toBeInTheDocument();
    expect(screen.getByText(c.consentTitle)).toBeInTheDocument();
    expect(screen.getByText(c.feePreview('KES 1,500', 'KES 0', 'KES 1,500'))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(c.phone), { target: { value: '0712345678' } });
    fireEvent.click(screen.getByLabelText(c.everyDay));
    fireEvent.change(screen.getByLabelText(c.atHour), { target: { value: '9' } });
    // The fee is shown on the money owed before anything is saved, to the shilling: 2.5% of
    // KES 1,500 is KES 37.50, and half a shilling rounds up to KES 38.
    fireEvent.change(screen.getByLabelText(c.feePercent), { target: { value: '2.5' } });
    expect(screen.getByText(c.feePreview('KES 1,500', 'KES 38', 'KES 1,462'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: c.save }));

    // Nothing has gone to the server yet: the password dialog is in front of it.
    expect(posted).toHaveLength(0);
    expect(screen.getByLabelText(copy.confirm.yourPassword)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      destinationPhone: '0712345678', schedule: 'daily', hour: 9, weekday: 1,
      fee: { percentBp: 250, flatCents: 0, floorCents: null, ceilingCents: null },
      password: 'correct horse',
    });
  });

  it('stops with one press, and the money stays owed and visible', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/sweep': () => new Response(JSON.stringify(list()), { status: 200 }),
      'POST /api/sweep/b1/stop': (init) => {
        posted.push(JSON.parse(String(init?.body)));
        const next = list();
        return new Response(JSON.stringify({ ...next.items[0], stopped: true }), { status: 200 });
      },
    }));
    render(<MemoryRouter><Sweep /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Kilimani Flats/ });

    fireEvent.click(within(screen.getByTestId('sweep-b1')).getByRole('button', { name: c.stop }));
    await waitFor(() => expect(posted).toEqual([{ stopped: true }]));
    // No password was asked for, and nothing left the page: the money is still owed.
    expect(screen.queryByLabelText(copy.confirm.yourPassword)).not.toBeInTheDocument();
    expect(screen.getByTestId('owed-b1')).toHaveTextContent(c.owedTitle + ': KES 1,500');
    expect(screen.getByTestId('owed-b1')).toHaveTextContent('R1');
    expect(await screen.findByRole('button', { name: c.start })).toBeInTheDocument();
  });

  it('says nothing at all when the studio has no businesses yet', async () => {
    vi.stubGlobal('fetch', fetchFor({ 'GET /api/sweep': () => new Response(JSON.stringify({ items: [], minCents: 1000 }), { status: 200 }) }));
    render(<MemoryRouter><Sweep /></MemoryRouter>);
    expect(await screen.findByText(c.empty)).toBeInTheDocument();
  });
});
