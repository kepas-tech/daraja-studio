import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Tier } from '../pages/setup/Tier';
import { copy } from '../copy/en';

vi.mock('../app/session', () => ({
  useSession: () => ({ status: 'setup', person: { id: 'p1', display_name: 'Owner', is_owner: true }, org: null, permissions: [], modules: { off: [], menuOff: [] } }),
}));
afterEach(() => cleanup());

/** GET /api/modules as the wizard reads it: the three tiers, and what each turns on. */
const view = () => ({
  tier: 'business', chosen: false, matches: 'business', departures: 0,
  tiers: [
    { key: 'simple', name: 'Simple', sentence: 'A shop or a stall: take money, send money, history, contacts, notifications.', on: ['contacts', 'notifications'], planned: [] },
    { key: 'business', name: 'Business', sentence: 'Studio as it stands today: businesses and account numbers, statements and arrears, invoices.', on: ['contacts', 'notifications', 'invoices'], planned: ['scheduled_payments'] },
    { key: 'platform', name: 'Platform', sentence: 'Everything in Business, plus the developer surface and the payment feed.', on: ['contacts', 'notifications', 'invoices', 'developer', 'feed'], planned: ['scheduled_payments', 'custody'] },
  ],
  modules: [
    { key: 'contacts', name: 'Contacts', on: true, built: true, switchable: true, changed: false, sentence: '.', hides: '.', permissions: [], menu: [], needs: [], heldBy: [] },
    { key: 'notifications', name: 'Notifications and push', on: true, built: true, switchable: true, changed: false, sentence: '.', hides: '.', permissions: [], menu: [], needs: [], heldBy: [] },
    { key: 'invoices', name: 'Invoices', on: true, built: true, switchable: true, changed: false, sentence: '.', hides: '.', permissions: [], menu: [], needs: [], heldBy: [] },
    { key: 'developer', name: 'Developer', on: true, built: true, switchable: true, changed: false, sentence: '.', hides: '.', permissions: [], menu: [], needs: [], heldBy: [] },
    { key: 'feed', name: 'Payment feed', on: true, built: true, switchable: true, changed: false, sentence: '.', hides: '.', permissions: [], menu: [], needs: [], heldBy: [] },
    { key: 'scheduled_payments', name: 'Scheduled payments', on: false, built: false, switchable: false, changed: false, sentence: '.', hides: '.', permissions: [], menu: [], needs: [], heldBy: [] },
    { key: 'custody', name: 'Custody', on: false, built: false, switchable: false, changed: false, sentence: '.', hides: '.', permissions: [], menu: [], needs: [], heldBy: [] },
  ],
});

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('the tier step of the wizard', () => {
  it('offers the three tiers the server declares, with Business preselected', async () => {
    vi.stubGlobal('fetch', fetchFor({ 'GET /api/modules': () => new Response(JSON.stringify(view()), { status: 200 }) }));
    let done = 0;
    render(<MemoryRouter><Tier onDone={() => { done += 1; }} /></MemoryRouter>);
    expect(await screen.findByTestId('setup-tier-business')).toBeInTheDocument();
    for (const t of view().tiers) expect(screen.getByRole('radio', { name: t.name })).toBeInTheDocument();
    // Business is the starting point, and it is the one already chosen.
    expect(screen.getByRole('radio', { name: 'Business' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Simple' })).not.toBeChecked();
    // What each turns on is named, and the parts that are not built are not offered as switched on.
    expect(screen.getByTestId('setup-tier-simple')).toHaveTextContent('Contacts, Notifications');
    expect(screen.getByRole('heading', { name: copy.setup.tier.title })).toBeInTheDocument();
    expect(done).toBe(0);
  });

  it('saves the tier the owner picked and moves to the next step', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/modules': () => new Response(JSON.stringify(view()), { status: 200 }),
      'POST /api/setup/tier': (init) => { posted = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); },
    }));
    let done = 0;
    render(<MemoryRouter><Tier onDone={() => { done += 1; }} /></MemoryRouter>);
    await screen.findByTestId('setup-tier-platform');
    fireEvent.click(screen.getByRole('radio', { name: 'Platform' }));
    expect(screen.getByRole('radio', { name: 'Platform' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));
    await waitFor(() => expect(posted).toEqual({ tier: 'platform' }));
    await waitFor(() => expect(done).toBe(1));
  });
});
