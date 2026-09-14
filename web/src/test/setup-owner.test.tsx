import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { Owner } from '../pages/setup/Owner';

describe('Setup › Owner', () => {
  it('blocks short passwords client-side and posts valid ones', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ person: { id: '1' }, csrf: 'c' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Owner onDone={() => {}} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Choose a password (12+ characters)'), { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: 'Create owner' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Choose a password (12+ characters)'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create owner' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/setup/owner', expect.objectContaining({ method: 'POST' })));
  });
});
