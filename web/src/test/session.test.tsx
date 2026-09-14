import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AppRouter } from '../app/router';
import { copy } from '../copy/en';

describe('session gate error state', () => {
  it('shows a retry card when the server is unreachable, and leaves it once the server responds', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetchMock);

    render(<AppRouter />);
    expect(await screen.findByText(copy.app.errorTitle)).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: copy.app.retry });

    fetchMock.mockImplementation(async (input) => {
      if (input === '/api/setup/status') return new Response(JSON.stringify({ needsOwner: true, completed: false, step: null }), { status: 200 });
      throw new Error(`unexpected fetch to ${String(input)}`);
    });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByText(copy.app.errorTitle)).not.toBeInTheDocument());
  });
});
