import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi } from 'vitest';
import { Login } from '../pages/Login';

describe('Login', () => {
  it('posts username and password and shows lock message on 423', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'locked', message: 'Too many wrong tries. Wait 15 minutes and try again.' } }), { status: 423 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><Login /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many wrong tries'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
  });
});
