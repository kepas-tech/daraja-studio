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
  createdBy: { id: 'p', displayName: 'Owner' }, webhook: null, ...over,
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

/**
 * Step six, part five: a key may hold its own webhook address, so the person setting one up names
 * where its payments' notices go in the same breath — and one key's receiver is never another's.
 */
const HOOK = 'h'.repeat(43);
const ORG = { url: 'https://org.test/api/hooks', secretHint: 'org1', updatedAt: '2026-09-18T10:00:00Z' };
const hookView = (url: string, hint = 'abcd') => ({ url, secretHint: hint, updatedAt: '2026-09-21T10:00:00Z' });

describe('key webhook addresses (part five)', () => {
  it('names the address a key will use in the same breath, and shows both secrets once', async () => {
    let made: unknown = null;
    const items: ReturnType<typeof key>[] = [];
    mount({
      'GET /api/keys': () => new Response(JSON.stringify({ items, organisation: ORG }), { status: 200 }),
      'POST /api/keys': (init) => {
        made = JSON.parse(String(init?.body));
        const created = key({ id: 'k2', name: 'Reporting', webhook: hookView('https://key.test/hooks') });
        items.push(created);
        return new Response(JSON.stringify({ key: created, secret: SECRET, webhook: { webhook: created.webhook, secret: HOOK } }), { status: 201 });
      },
    });
    await screen.findByText(copy.apiKeys.empty);

    fireEvent.change(screen.getByLabelText(copy.apiKeys.name), { target: { value: 'Reporting' } });
    fireEvent.change(screen.getByLabelText(copy.apiKeys.addressCreate), { target: { value: 'https://key.test/hooks' } });
    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.create }));

    expect(made).toEqual({ name: 'Reporting', role: 'viewer', webhookUrl: 'https://key.test/hooks' });
    expect(await screen.findByTestId('key-secret')).toHaveTextContent(SECRET);
    expect(screen.getByTestId('key-webhook-secret')).toHaveTextContent(HOOK);
    expect(screen.getByTestId('key-shown-once')).toHaveTextContent(copy.apiKeys.webhookShownOnce('https://key.test/hooks'));
    // The row says where its notices go, without a second visit to another page.
    expect(await screen.findByTestId('key-address-k2')).toHaveTextContent('https://key.test/hooks');
  });

  it('shows a key its own address, and the organisation address when it has none', async () => {
    mount({
      'GET /api/keys': () => new Response(JSON.stringify({
        items: [key({ id: 'own', webhook: hookView('https://own.test/hooks') }), key({ id: 'inherits' })],
        organisation: ORG,
      }), { status: 200 }),
    });
    expect(await screen.findByTestId('key-address-own')).toHaveTextContent('https://own.test/hooks');
    expect(screen.getByTestId('key-address-own')).toHaveTextContent('abcd');
    expect(screen.getByTestId('key-address-inherits')).toHaveTextContent(ORG.url);
  });

  it('changes a key address, keeps its secret, and can make a new one', async () => {
    let items = [key({ id: 'k1', webhook: hookView('https://old.test/hooks', 'old1') })];
    let putBody: unknown = null;
    mount({
      'GET /api/keys': () => new Response(JSON.stringify({ items, organisation: ORG }), { status: 200 }),
      'PUT /api/keys/k1/webhook': (init) => {
        putBody = JSON.parse(String(init?.body));
        items = [key({ id: 'k1', webhook: hookView('https://new.test/hooks', 'old1') })];
        return new Response(JSON.stringify({ webhook: items[0]!.webhook, secret: null }), { status: 200 });
      },
      'POST /api/keys/k1/webhook/secret': () => new Response(JSON.stringify({
        webhook: hookView('https://new.test/hooks', HOOK.slice(-4)), secret: HOOK,
      }), { status: 200 }),
    });
    await screen.findByTestId('key-k1');

    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.addressButton }));
    fireEvent.change(screen.getByLabelText(copy.apiKeys.address), { target: { value: 'https://new.test/hooks' } });
    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.addressSave }));
    expect(await screen.findByText(copy.apiKeys.afterAddress)).toBeInTheDocument();
    expect(putBody).toEqual({ url: 'https://new.test/hooks' });
    expect(await screen.findByTestId('key-address-k1')).toHaveTextContent('https://new.test/hooks');

    // A new signing secret is shown once, in the same panel as a key's own.
    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.addressButton }));
    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.addressSecret }));
    expect(await screen.findByTestId('key-webhook-secret')).toHaveTextContent(HOOK);
    expect(screen.getByText(copy.apiKeys.afterAddressSecret)).toBeInTheDocument();
  });

  it('stops a key using its own address, and says what happens to what is already written', async () => {
    let removed = false;
    mount({
      'GET /api/keys': () => new Response(JSON.stringify({
        items: removed ? [key({ id: 'k1' })] : [key({ id: 'k1', webhook: hookView('https://own.test/hooks') })],
        organisation: ORG,
      }), { status: 200 }),
      'DELETE /api/keys/k1/webhook': () => { removed = true; return new Response(null, { status: 204 }); },
    });
    await screen.findByTestId('key-k1');

    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.addressButton }));
    fireEvent.click(screen.getByRole('button', { name: copy.apiKeys.addressRemove }));
    expect(await screen.findByText(copy.apiKeys.afterAddressRemoved)).toBeInTheDocument();
    expect(await screen.findByTestId('key-address-k1')).toHaveTextContent(ORG.url);
  });
});

