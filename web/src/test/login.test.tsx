import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Login } from '../pages/Login';
import { copy } from '../copy/en';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** The only call the login screen makes on its own: the install's state, which carries its name. */
function statusAnswer(body: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/setup/status') return new Response(JSON.stringify(body), { status: 200 });
    throw new Error('unexpected fetch ' + String(input));
  });
}

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

  it('says which studio this is: the address, and the install own name where it has one', async () => {
    vi.stubGlobal('fetch', statusAnswer({ needsOwner: false, completed: true, step: 'done', studioName: 'KEPAS TECHNOLOGIES' }));
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(await screen.findByText(copy.login.where('KEPAS TECHNOLOGIES', window.location.host))).toBeInTheDocument();
  });

  it('says only the address where the install has no name of its own', async () => {
    vi.stubGlobal('fetch', statusAnswer({ needsOwner: true, completed: false, step: null, studioName: null }));
    render(<MemoryRouter><Login /></MemoryRouter>);
    // The address is true the moment the page is drawn; the name is added only if there is one.
    expect(await screen.findByText(window.location.host)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/·/)).not.toBeInTheDocument());
  });

  it('still gives the address when the install cannot be asked at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<MemoryRouter><Login /></MemoryRouter>);
    expect(await screen.findByText(window.location.host)).toBeInTheDocument();
  });
});
