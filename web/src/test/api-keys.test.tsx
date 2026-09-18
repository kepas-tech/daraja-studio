import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiKeys } from '../pages/ApiKeys';
import { copy } from '../copy/en';

afterEach(() => cleanup());

/** Round 3, phase E: API keys, and the one rule the page turns on — the secret is shown once. */
const key = (over: Record<string, unknown> = {}) => ({
  id: 'k1', name: 'Payroll script', prefix: 'a1b2c3d4e5f6', role: 'viewer',
  createdAt: '2026-09-18T10:00:00Z', lastUsedAt: null, revokedAt: null, rotatedFrom: null,
  createdBy: { id: 'p', displayName: 'Owner' }, ...over,
});
const SECRET = 'studio_a1b2c3d4e5f6_' + 'S'.repeat(43);

function mount(handlers: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const k = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[k];
    if (!h) throw new Error(`unexpected fetch ${k}`);
    return h(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><ApiKeys /></MemoryRouter>);
  return fetchMock;
}

describe('API keys (phase E)', () => {
  it('shows a new key once, and never again after Done', async () => {
    let made: unknown = null;
    mount({
      'GET /api/keys': () => new Response(JSON.stringify({ items: [key()] }), { status: 200 }),
      'POST /api/keys': (init) => { made = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ key: key({ id: 'k2', name: 'Reporting' }), secret: SECRET }), { status: 201 }); },
    });
    // The list shows the prefix and the facts, and no secret anywhere.
    const row = await screen.findByTestId('key-k1');
    expect(row).toHaveTextContent('a1b2c3d4e5f6');
    expect(row).toHaveTextContent(copy.apiKeys.neverUsed);
    expect(document.body.textContent).not.toContain(SECRET);

    fireEvent.change(screen.getByLabelText(copy.apiKeys.name), { target: { value: 'Reporting' } });
    fireEvent.change(screen.getByLabelText(copy.apiKeys.role), { target: { value: 'operator' } });
    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.create }));

    const shown = await screen.findByTestId('key-shown-once');
    expect(shown).toHaveTextContent(copy.apiKeys.shownOnce);
    expect(screen.getByTestId('key-secret')).toHaveTextContent(SECRET);
    expect(made).toEqual({ name: 'Reporting', role: 'operator' });

    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.gotIt }));
    await waitFor(() => expect(screen.queryByTestId('key-shown-once')).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('rotates: a new secret once, the old key stopped', async () => {
    const stopped = key({ id: 'k0', prefix: 'ffffffffffff', revokedAt: '2026-09-18T11:00:00Z' });
    mount({
      'GET /api/keys': () => new Response(JSON.stringify({ items: [key({ id: 'k2', prefix: '999999999999', rotatedFrom: 'k1' }), stopped] }), { status: 200 }),
      'POST /api/keys/k2/rotate': () => new Response(JSON.stringify({ key: key({ id: 'k3', prefix: '999999999999' }), secret: SECRET }), { status: 201 }),
    });
    await screen.findByTestId('key-k2');

    // The rotate button lives on a live key's row.
    fireEvent.click(screen.getAllByRole('button', { name: copy.apiKeys.rotate })[0]!);
    expect(await screen.findByTestId('key-shown-once')).toHaveTextContent(SECRET);
    expect(screen.getByText(copy.apiKeys.afterRotate)).toBeInTheDocument();
    expect(screen.getByTestId('key-k2')).toHaveTextContent(copy.apiKeys.rotatedFrom);
    // The stopped key has no buttons, and says when it stopped.
    expect(screen.getByTestId('key-k0')).toHaveTextContent(copy.apiKeys.revoked('18 Sept 2026, 14:00'));
  });

  it('revokes a key and says so', async () => {
    let revoked = false;
    mount({
      'GET /api/keys': () => new Response(JSON.stringify({ items: [key({ revokedAt: revoked ? '2026-09-18T11:00:00Z' : null })] }), { status: 200 }),
      'POST /api/keys/k1/revoke': () => { revoked = true; return new Response(JSON.stringify(key({ revokedAt: '2026-09-18T11:00:00Z' })), { status: 200 }); },
    });
    await screen.findByTestId('key-k1');
    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.revoke }));
    expect(await screen.findByText(copy.apiKeys.afterRevoke)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: copy.apiKeys.revoke })).toBeNull());
  });

  it('says there are none yet', async () => {
    mount({ 'GET /api/keys': () => new Response(JSON.stringify({ items: [] }), { status: 200 }) });
    expect(await screen.findByText(copy.apiKeys.empty)).toBeInTheDocument();
  });
});
