import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Webhooks } from '../pages/Webhooks';
import { copy } from '../copy/en';

afterEach(() => cleanup());

const SET = { url: 'https://example.test/hooks/studio', secretHint: 'ab12', updatedAt: '2026-09-18T10:00:00Z' };
const SECRET = 'K'.repeat(43);

function mount(handlers: Record<string, (init?: RequestInit) => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const k = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[k];
    if (!h) throw new Error(`unexpected fetch ${k}`);
    return h(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><Webhooks /></MemoryRouter>);
  return fetchMock;
}

describe('Webhooks (phase E)', () => {
  it('saves an address, shows the secret once, and never again', async () => {
    let saved: unknown = null;
    mount({
      'GET /api/webhooks': () => new Response(JSON.stringify({ webhook: { url: null, secretHint: null, updatedAt: null } }), { status: 200 }),
      'PUT /api/webhooks': (init) => { saved = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ webhook: SET, secret: SECRET }), { status: 200 }); },
    });
    await screen.findByLabelText(copy.webhooks.url);
    fireEvent.change(screen.getByLabelText(copy.webhooks.url), { target: { value: SET.url } });
    fireEvent.click(screen.getByRole('button', { name: copy.webhooks.save }));

    const shown = await screen.findByTestId('secret-shown-once');
    expect(shown).toHaveTextContent(copy.webhooks.shownOnce);
    expect(screen.getByTestId('webhook-secret')).toHaveTextContent(SECRET);
    expect(shown).toHaveTextContent('X-Studio-Signature');
    expect(saved).toEqual({ url: SET.url });

    fireEvent.click(screen.getByRole('button', { name: copy.webhooks.gotIt }));
    await waitFor(() => expect(screen.queryByTestId('secret-shown-once')).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    // What is left is the address line, with the hint rather than the secret.
    expect(screen.getByText(copy.webhooks.inUse(SET.url, 'ab12', '18 Sept 2026, 13:00'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.webhooks.deliveriesLink })).toHaveAttribute('href', '/webhooks/deliveries');
  });

  it('rotates the secret and stops sending', async () => {
    let stopped = false;
    mount({
      'GET /api/webhooks': () => new Response(JSON.stringify({ webhook: SET }), { status: 200 }),
      'POST /api/webhooks/secret': () => new Response(JSON.stringify({ webhook: { ...SET, secretHint: 'zz99' }, secret: SECRET }), { status: 200 }),
      'DELETE /api/webhooks': () => { stopped = true; return new Response(null, { status: 204 }); },
    });
    await screen.findByText(copy.webhooks.inUse(SET.url, 'ab12', '18 Sept 2026, 13:00'));

    fireEvent.click(screen.getByRole('button', { name: copy.webhooks.newSecret }));
    expect(await screen.findByTestId('secret-shown-once')).toHaveTextContent(SECRET);
    expect(screen.getByText(copy.webhooks.afterRotate)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.webhooks.gotIt }));

    fireEvent.click(screen.getByRole('button', { name: copy.webhooks.remove }));
    expect(await screen.findByText(copy.webhooks.afterRemove)).toBeInTheDocument();
    expect(stopped).toBe(true);
    await waitFor(() => expect(screen.queryByRole('link', { name: copy.webhooks.deliveriesLink })).toBeNull());
  });

  it('shows the refusal when the address is not a public https one', async () => {
    mount({
      'GET /api/webhooks': () => new Response(JSON.stringify({ webhook: { url: null, secretHint: null, updatedAt: null } }), { status: 200 }),
      'PUT /api/webhooks': () => new Response(JSON.stringify({ error: { code: 'bad_url', message: 'That address is inside the network, not on the internet.' } }), { status: 400 }),
    });
    await screen.findByLabelText(copy.webhooks.url);
    fireEvent.change(screen.getByLabelText(copy.webhooks.url), { target: { value: 'https://10.0.0.1/hook' } });
    fireEvent.click(screen.getByRole('button', { name: copy.webhooks.save }));
    expect(await screen.findByText('That address is inside the network, not on the internet.')).toBeInTheDocument();
  });
});
