import { render, screen, within, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Modules } from '../pages/Modules';
import { Nav } from '../app/Nav';
import { copy } from '../copy/en';

class FakeEventSource {
  listeners: Record<string, EventListener[]> = {};
  onopen: (() => void) | null = null;
  addEventListener(type: string, cb: EventListener) { (this.listeners[type] ??= []).push(cb); }
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);
/** The owner, signed in, in a studio where Invoices is switched off. */
vi.mock('../app/session', () => ({
  useSession: () => ({
    status: 'ready', person: { id: 'p1', display_name: 'Owner', is_owner: true }, org: null,
    permissions: [], pinSet: false, modules: { off: ['invoices'], menuOff: ['invoices'] }, refresh: async () => {},
  }),
}));
afterEach(() => cleanup());

type ModuleState = import('../api/types').ModuleState;
type Module = ModuleState['modules'][number];
const mod = (over: Pick<Module, 'key' | 'name' | 'sentence'> & Partial<Module>): Module => ({
  on: true, built: true, switchable: true, changed: false, permissions: [], menu: [], needs: [], heldBy: [], hides: 'its page', ...over,
});
/** GET /api/modules as the page reads it: five modules is enough to say everything the page says. */
const view = (over: Partial<ModuleState> = {}): ModuleState => ({
  tier: 'business', chosen: true, matches: 'business', departures: 0,
  tiers: [
    { key: 'simple', name: 'Simple', sentence: 'A shop or a stall: take money, send money, history, contacts, notifications.', on: ['contacts', 'notifications'], planned: [] },
    { key: 'business', name: 'Business', sentence: 'Studio as it stands today: businesses and account numbers, statements, invoices, people, approvals and reports.', on: ['contacts', 'notifications', 'invoices'], planned: [] },
    { key: 'platform', name: 'Platform', sentence: 'Everything in Business, plus the developer surface and the payment feed.', on: ['contacts', 'notifications', 'invoices', 'developer', 'feed'], planned: ['custody'] },
  ],
  modules: [
    mod({ key: 'contacts', name: 'Contacts', sentence: 'The people and businesses you pay often, saved once.', permissions: [{ key: 'contacts.manage', label: 'Can keep the contact list' }], menu: ['contacts'], hides: 'the address book, and the saved names in Send and Bulk' }),
    mod({ key: 'invoices', name: 'Invoices', on: false, changed: true, sentence: 'Bills your customers can pay, with reminders.', menu: ['invoices'], hides: 'the Invoices page and every bill in it' }),
    mod({ key: 'people', name: 'People and roles', sentence: 'Who may log in, and what each of them may do.', hides: 'the People page and every role', heldBy: [{ key: 'approvals', name: 'Approvals' }] }),
    mod({ key: 'approvals', name: 'Approvals', sentence: 'A second person releases a send above the amount you set.', menu: ['approvals'], hides: 'Waiting and the approval setting', needs: [{ key: 'people', name: 'People and roles', on: true }] }),
    mod({ key: 'scheduled_payments', name: 'Scheduled payments', on: false, built: false, switchable: false, sentence: 'Pay the same people on a timetable.', hides: 'nothing yet — it is not built', needs: [{ key: 'money_out', name: 'Money out', on: true }, { key: 'contacts', name: 'Contacts', on: true }] }),
    mod({ key: 'custody', name: 'Custody', on: false, built: false, switchable: false, sentence: 'Studio holds customer balances: wallets, a double-entry ledger, and the float rule.', hides: 'nothing yet — it is not built' }),
  ],
  ...over,
});

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('What this studio does', () => {
  it('lists every part of Studio with its sentence, its permissions and what turning it off hides', async () => {
    vi.stubGlobal('fetch', fetchFor({ 'GET /api/modules': () => new Response(JSON.stringify(view()), { status: 200 }) }));
    render(<MemoryRouter><Modules /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(copy.modulesPage.title);
    expect(screen.getByText('The people and businesses you pay often, saved once.')).toBeInTheDocument();
    expect(screen.getByText('Can keep the contact list')).toBeInTheDocument();
    expect(screen.getByText(/the address book, and the saved names in Send and Bulk/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Custody' })).toBeInTheDocument();
    // The three tiers, with what each turns on, sit above the modules.
    for (const t of view().tiers) expect(screen.getByText(t.name)).toBeInTheDocument();
    expect(screen.getByText(view().tiers[0]!.sentence)).toBeInTheDocument();
    // What each tier turns on, named in the tier's own card.
    expect(screen.getAllByText(/Turns on:/)).toHaveLength(view().tiers.length);
    // Both parts that are declared and not built are listed, and neither has a switch.
    expect(screen.getAllByText(copy.modulesPage.notBuilt)).toHaveLength(2);
    const scheduled = screen.getByRole('heading', { name: 'Scheduled payments' }).closest('[data-testid]') as HTMLElement;
    expect(scheduled).toHaveTextContent('Pay the same people on a timetable.');
    // What it stands on is named, money out included: a part that is always on and has no switch.
    expect(scheduled).toHaveTextContent(copy.modulesPage.needs + ': Money out · Contacts');
    expect(within(scheduled).queryByRole('button')).toBeNull();
  });

  it('says which module is holding another one on, and will not offer to switch it off', async () => {
    vi.stubGlobal('fetch', fetchFor({ 'GET /api/modules': () => new Response(JSON.stringify(view()), { status: 200 }) }));
    render(<MemoryRouter><Modules /></MemoryRouter>);
    const row = (await screen.findByRole('heading', { name: 'People and roles' })).closest('[data-testid]') as HTMLElement;
    expect(row).toHaveTextContent(copy.modulesPage.holding('Approvals'));
    expect(screen.getAllByRole('button', { name: copy.modulesPage.turnOff }).some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('turns a module off behind the password, and shows it off when the answer comes back', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/modules': () => new Response(JSON.stringify(view()), { status: 200 }),
      'POST /api/modules/contacts': (init) => {
        posted = JSON.parse(String(init?.body));
        const v = view();
        v.modules = v.modules.map((m) => (m.key === 'contacts' ? { ...m, on: false } : m));
        return new Response(JSON.stringify({ ...v, alsoOn: [] }), { status: 200 });
      },
    }));
    render(<MemoryRouter><Modules /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Contacts' });
    fireEvent.click(screen.getAllByRole('button', { name: copy.modulesPage.turnOff })[0]!);
    await screen.findByText(copy.modulesPage.confirmOff('Contacts'));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(posted).toEqual({ enabled: false, password: 'correct horse' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: copy.modulesPage.turnOn }).length).toBeGreaterThan(0));
  });

  it('previews a tier change before it applies it, and applies it with the password', async () => {
    let applied: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'GET /api/modules': () => new Response(JSON.stringify(view()), { status: 200 }),
      'POST /api/modules/tier/preview': () => new Response(JSON.stringify({
        from: 'business', tier: 'simple',
        changes: [{ key: 'invoices', name: 'Invoices', from: true, to: false }, { key: 'people', name: 'People and roles', from: true, to: false }],
        on: ['contacts', 'notifications'], off: ['invoices', 'people'],
      }), { status: 200 }),
      'POST /api/modules/tier': (init) => {
        applied = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(view({ tier: 'simple', matches: 'simple' })), { status: 200 });
      },
    }));
    render(<MemoryRouter><Modules /></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Contacts' });
    fireEvent.click(screen.getByRole('radio', { name: 'Simple' }));
    expect(applied).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.modulesPage.preview }));
    await screen.findByText(copy.modulesPage.previewTitle('Simple'));
    const preview = within(screen.getByTestId('tier-preview'));
    expect(preview.getByText('Invoices')).toBeInTheDocument();
    // Two parts go off, and the preview says so beside each one.
    expect(preview.getAllByText(copy.modulesPage.turnsOff)).toHaveLength(2);
    // Nothing has been applied by looking.
    expect(applied).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.modulesPage.apply('Simple') }));
    await screen.findByText(copy.modulesPage.confirmTier('Simple'));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
    await waitFor(() => expect(applied).toEqual({ tier: 'simple', password: 'correct horse' }));
  });

  it('stops the menu offering what is switched off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0, enabled: true, badge: 0, unread: 0 }), { status: 200 })));
    render(<MemoryRouter><Nav /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector('a[href="/contacts"]')).not.toBeNull());
    expect(document.querySelector('a[href="/invoices"]')).toBeNull();
  });
});
