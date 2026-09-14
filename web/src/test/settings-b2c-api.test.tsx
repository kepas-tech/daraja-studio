import { render, screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Settings } from '../pages/Settings';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

class FakeEventSource {
  addEventListener() {}
  close() {}
}
vi.stubGlobal('EventSource', FakeEventSource);

afterEach(() => cleanup());

const emptySlot = {
  shortcode: null,
  consumerKey: { saved: false, last4: null }, consumerSecret: { saved: false, last4: null }, credsVerifiedAt: null,
  passkey: { saved: false, last4: null }, cert: { saved: false, last4: null },
  operators: [], ready: { creds: false, operator: false },
  b2cApi: { setting: 'auto' as const, detected: null, detectedAt: null },
};
const detectedAt = '2026-09-07T07:00:00Z';
const productionSlot = {
  ...emptySlot,
  shortcode: '700111',
  consumerKey: { saved: true, last4: '4f2a' }, consumerSecret: { saved: true, last4: null }, credsVerifiedAt: '2026-09-07T07:00:00Z',
  operators: [{ id: 'a', name: 'KEPAS', environment: 'production' as const, status: 'verified' as const, priority: 1, rotatedAt: '2026-09-02T00:00:00Z', lastProbeAt: null, lastError: null, expiresAt: '2026-12-01T00:00:00Z' }],
  ready: { creds: true, operator: true },
  b2cApi: { setting: 'auto' as const, detected: 'v1' as const, detectedAt },
};
const view = {
  mode: 'production',
  environments: { sandbox: emptySlot, production: productionSlot },
  org: { name: 'KEPAS', nominatedNumber: '254700000000', notificationPhone: '254700000000' },
  stkEnabled: false, publicUrl: 'https://x', publicVerifiedAt: null, httpsSeen: false,
  allowlist: ['1.1.1.1'], setupCompletedAt: 'x',
};

async function renderAndWait() {
  render(<MemoryRouter><ToastHost /><Settings /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());
}

function b2cSection() {
  const section = screen.getByTestId('setting-b2c-api');
  if (within(section).queryAllByRole('radio').length === 0) fireEvent.click(within(section).getByRole('button', { name: copy.settings.change }));
  return section;
}
// The radio group is `[auto, v1, v3]` in that fixed order (see B2C_VERSIONS in EnvironmentTab.tsx).
// getByLabelText can't disambiguate "v3" here — the Automatic option's own hint text mentions "v3"
// too ("...choose v3 here."), so it substring-matches both labels.
const radioAt = (section: HTMLElement, i: number) => within(section).getAllByRole('radio')[i]!;

describe('Settings › B2C API version', () => {
  it('renders the three options with the Automatic hint, and the detected line from the fixture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(view), { status: 200 })));
    await renderAndWait();

    const section = b2cSection();
    expect(within(section).getAllByRole('radio')).toHaveLength(3);
    expect(within(section).getByText(copy.settings.b2cApi.auto)).toBeInTheDocument();
    expect(within(section).getByText(copy.settings.b2cApi.v1)).toBeInTheDocument();
    expect(within(section).getByText(copy.settings.b2cApi.v3)).toBeInTheDocument();
    expect(within(section).getByText(copy.settings.b2cApi.autoHint)).toBeInTheDocument();
    expect(within(section).getByText('Detected: v1', { exact: false })).toBeInTheDocument();
  });

  it('choosing v3 and saving posts to environments/production/b2c-api with {version, password} and toasts', async () => {
    const updated = { ...view, environments: { ...view.environments, production: { ...productionSlot, b2cApi: { setting: 'v3' as const, detected: null, detectedAt: null } } } };
    let gets = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/settings' && method === 'GET') { gets += 1; return new Response(JSON.stringify(gets === 1 ? view : updated), { status: 200 }); }
      if (url === '/api/settings/environments/production/b2c-api' && method === 'PUT') return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderAndWait();

    const section = b2cSection();
    fireEvent.click(radioAt(section, 2));
    fireEvent.click(within(section).getByRole('button', { name: copy.settings.save }));
    fireEvent.change(screen.getByLabelText(copy.confirm.yourPassword), { target: { value: 'studio-pw' } });
    fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/settings/environments/production/b2c-api', expect.objectContaining({ method: 'PUT' })));
    const call = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/settings/environments/production/b2c-api' && (i as RequestInit | undefined)?.method === 'PUT');
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({ version: 'v3', password: 'studio-pw' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(copy.settings.b2cApi.saved));

    // The view reload shows the new selection, and the detected line is gone once the fixture
    // reports detected: null (a changed choice invalidates whatever was auto-detected before it).
    await waitFor(() => expect(radioAt(b2cSection(), 2)).toBeChecked());
    expect(within(b2cSection()).queryByText(/Detected:/)).not.toBeInTheDocument();
  });
});
