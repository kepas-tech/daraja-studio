import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionProvider } from '../app/session';
import { Home } from '../pages/Home';
import { copy } from '../copy/en';

// Home opens the event stream once; this test is about what the server already said.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);
afterEach(() => cleanup());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const me = { person: { id: '1', username: 'owner', display_name: 'Owner', is_owner: true, must_change_password: false }, csrf: 'c', permissions: [] };
const slot = { shortcode: '600999', consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: 'x', passkey: { saved: true, last4: null }, cert: { saved: false, last4: null }, operators: [], ready: { creds: true, operator: true }, b2cApi: { setting: 'auto', detected: null, detectedAt: null } };
const settings = {
  mode: 'production', environments: { sandbox: slot, production: slot },
  org: { name: 'Studio', nominatedNumber: '', notificationPhone: '' },
  publicVerifiedAt: 'x', stkEnabled: true, publicUrl: 'https://studio.example', httpsSeen: true, allowlist: [], setupCompletedAt: 'x',
};

/** Home with exactly these problems reported, and nothing else in the way. */
function mount(problems: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/setup/status') return json({ needsOwner: false, completed: true, step: null });
    if (url === '/api/auth/me') return json(me);
    if (url === '/api/settings') return json(settings);
    if (url.includes('/api/health/problems')) return json({ items: problems });
    if (url.includes('/api/balances/latest')) return json(null);
    if (url.startsWith('/api/requests?')) return json({ items: [], nextCursor: null });
    if (url.includes('/api/businesses/summary')) return json({ items: [] });
    if (url.includes('/api/reports/summary')) return json({ inCents: 0, inCount: 0, outCents: 0, outCount: 0, pending: 0, failed: 0 });
    return json({});
  }));
  render(<MemoryRouter><SessionProvider><Home /></SessionProvider></MemoryRouter>);
}

describe('Something is wrong, on Home', () => {
  it('says one sentence per problem, each with one link to the place that fixes it', async () => {
    mount([
      { kind: 'operator_down', detail: null },
      { kind: 'no_callback', detail: null },
      { kind: 'balance_refused', detail: null },
    ]);
    const banner = await screen.findByTestId('home-problems');
    expect(within(banner).getByText(copy.home.problems.title)).toBeInTheDocument();
    for (const kind of ['operator_down', 'no_callback', 'balance_refused']) {
      // Two of the three link to Settings, so the link is checked inside its own line.
      const line = within(banner).getByText(copy.home.problems.sentence[kind]!).closest('li')!;
      expect(within(line).getByRole('link', { name: copy.home.problems.open[kind]! })).toHaveAttribute('href', copy.home.problems.to[kind]);
    }
  });

  it('shows the specifics only when the server sends them, which only the owner gets', async () => {
    mount([{ kind: 'operator_down', detail: { name: 'APIONE', minutes: 42 } }]);
    const banner = await screen.findByTestId('home-problems');
    expect(within(banner).getByText(copy.home.problems.detail.operator_down!({ name: 'APIONE', minutes: 42 }))).toBeInTheDocument();
    cleanup();
    // The same problem, seen by everybody else: the sentence, and no line under it.
    mount([{ kind: 'operator_down', detail: null }]);
    const again = await screen.findByTestId('home-problems');
    expect(within(again).getByText(copy.home.problems.sentence.operator_down!)).toBeInTheDocument();
    expect(within(again).queryByText(/has been down/)).toBeNull();
  });

  it('shows nothing at all while everything is fine', async () => {
    mount([]);
    expect(await screen.findByText(copy.home.recent)).toBeInTheDocument();
    expect(screen.queryByTestId('home-problems')).toBeNull();
  });
});
