import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Environment } from '../pages/setup/Environment';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('Setup › Environment', () => {
  it('renders both choices with their hints, sandbox pre-selected', () => {
    render(<Environment onDone={() => {}} />);

    const sandbox = screen.getByLabelText(copy.setup.env.sandbox, { exact: false }) as HTMLInputElement;
    const production = screen.getByLabelText(copy.setup.env.production, { exact: false }) as HTMLInputElement;
    expect(sandbox.checked).toBe(true);
    expect(production.checked).toBe(false);
    expect(screen.getByText(copy.setup.env.sandboxHint)).toBeInTheDocument();
    expect(screen.getByText(copy.setup.env.productionHint)).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.setup.env.confirm)).not.toBeInTheDocument();
  });

  it('continuing with sandbox posts to /api/setup/environment with sandbox, and toasts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/setup/environment' && init?.method === 'POST') return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<><ToastHost /><Environment onDone={onDone} /></>);

    fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/setup/environment', expect.objectContaining({ method: 'POST' })));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ environment: 'sandbox' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent(copy.settings.saved);
  });

  it('choosing production reveals the confirm-shortcode field and posts production with it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/setup/environment' && init?.method === 'POST') return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<Environment onDone={onDone} />);

    fireEvent.click(screen.getByLabelText(copy.setup.env.production, { exact: false }));
    expect(screen.getByLabelText(copy.setup.env.confirm)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(copy.setup.env.confirm), { target: { value: '4052037' } });
    fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/setup/environment', expect.objectContaining({ method: 'POST' })));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ environment: 'production', confirmShortcode: '4052037' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('shows the server error on a confirm_shortcode mismatch and does not call onDone', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'confirm_shortcode', message: 'Type your shortcode exactly to switch to production.' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<Environment onDone={onDone} />);

    fireEvent.click(screen.getByLabelText(copy.setup.env.production, { exact: false }));
    fireEvent.change(screen.getByLabelText(copy.setup.env.confirm), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));

    await screen.findByText('Type your shortcode exactly to switch to production.');
    expect(onDone).not.toHaveBeenCalled();
  });
});
