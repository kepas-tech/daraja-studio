import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Reconcile } from '../pages/Reconcile';
import { copy } from '../copy/en';

/**
 * Round 3, phase D-1: check nothing is missing. The page asks; the answer lists what does not agree,
 * and nothing is written.
 */
vi.mock('../app/session', () => ({ useSession: () => ({ status: 'ready', person: { id: 'p1', is_owner: true }, org: null, permissions: [], refresh: async () => {} }) }));
afterEach(() => cleanup());

const answer = (over: Record<string, unknown> = {}) => ({
  window: { days: 7, from: '2026-09-11T00:00:00Z', to: '2026-09-18T00:00:00Z' },
  safaricom: { records: 2, totalCents: 75000 },
  studio: { records: 1, totalCents: 25000 },
  missing: [{ receipt: 'RC00000001', amountCents: 50000, at: '2026-09-17T08:00:00Z', phone: '254700123456', accountReference: 'ACC-9' }],
  extra: [],
  balance: {
    latest: { workingCents: 1250000, utilityCents: 480000, at: '2026-09-18T07:00:00Z' },
    previous: { workingCents: 1000000, utilityCents: 500000, at: '2026-09-17T07:00:00Z' },
    movement: { inCents: 250000, outCents: 100000, chargeCents: 5000, paymentsIn: 1, paymentsOut: 1, workingChangeCents: 250000, utilityChangeCents: -20000, expectedChangeCents: 145000, actualChangeCents: 230000, differenceCents: 85000 },
  },
  checkedAt: '2026-09-18T08:00:00Z',
  ...over,
});

describe('check nothing is missing', () => {
  it('lists what Safaricom shows and Studio does not have, and the balance that does not agree', async () => {
    let posted: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/reconcile');
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(answer()), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Reconcile /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: copy.reconcile.check }));
    await screen.findByTestId('missing-RC00000001');
    expect(posted).toEqual({ days: 7 });
    expect(screen.getByTestId('safaricom-says')).toHaveTextContent(copy.reconcile.safaricomSays(2, 'KES 750'));
    expect(screen.getByTestId('studio-has')).toHaveTextContent(copy.reconcile.studioHas(1, 'KES 250'));
    expect(screen.getByTestId('missing-RC00000001')).toHaveTextContent('KES 500');
    expect(screen.getByTestId('missing-RC00000001')).toHaveTextContent('ACC-9');
    // The balance that does not agree says so, and by how much.
    expect(screen.getByTestId('balance-change')).toHaveTextContent(copy.reconcile.perAccount('KES 2,500', 'KES -200'));
    expect(screen.getByTestId('balance-agrees')).toHaveTextContent(copy.reconcile.differs('KES 850'));
    expect(screen.getByTestId('balance-movement')).toHaveTextContent(copy.reconcile.movement('KES 2,500', 'KES 1,000', 'KES 50', 1));
  });

  it('says plainly when nothing is missing and nothing is extra', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer({ missing: [], extra: [], safaricom: { records: 1, totalCents: 25000 } })), { status: 200 })));
    render(<MemoryRouter><Reconcile /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: copy.reconcile.check }));
    expect(await screen.findByText(copy.reconcile.missingNone)).toBeInTheDocument();
    expect(screen.getByText(copy.reconcile.extraNone)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('reconcile-checked')).toBeInTheDocument());
  });
});
