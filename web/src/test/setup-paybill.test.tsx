import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Paybill } from '../pages/setup/Paybill';
import { copy } from '../copy/en';

/** The wizard's session, as the paybill step reads it. */
const state = vi.hoisted(() => ({ paybill: null as 'own' | 'none' | null, signupUrl: 'https://kepas.darajastudio.com' as string | null }));
vi.mock('../app/session', () => ({
  useSession: () => ({ status: 'setup', paybill: state.paybill, signupUrl: state.signupUrl, refresh: async () => {} }),
}));
afterEach(() => { cleanup(); state.paybill = null; state.signupUrl = 'https://kepas.darajastudio.com'; });

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('the paybill question', () => {
  it('asks it in two plain answers, and "yes" carries straight on', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({ 'POST /api/setup/paybill': (init) => { posted = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); } }));
    let done = 0;
    render(<MemoryRouter><Paybill onDone={() => { done += 1; }} /></MemoryRouter>);
    expect(screen.getByTestId('paybill-question')).toHaveTextContent(copy.setup.paybill.title);
    fireEvent.click(screen.getByRole('button', { name: copy.setup.paybill.yes }));
    await waitFor(() => expect(posted).toEqual({ own: true }));
    await waitFor(() => expect(done).toBe(1));
  });

  it('says plainly what the alternative is when the answer is no, and points at the sign-up address', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({ 'POST /api/setup/paybill': (init) => { posted = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); } }));
    let done = 0;
    render(<MemoryRouter><Paybill onDone={() => { done += 1; }} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: copy.setup.paybill.no }));
    await waitFor(() => expect(posted).toEqual({ own: false }));

    const box = await screen.findByTestId('paybill-none');
    // Every line the person choosing this deserves to read before they start.
    for (const line of copy.setup.paybill.noneLines) expect(box).toHaveTextContent(line);
    expect(box).toHaveTextContent(copy.setup.paybill.comeBack);
    expect(screen.getByTestId('signup-link')).toHaveAttribute('href', 'https://kepas.darajastudio.com');
    // Saying no neither finishes setup nor leaves the step.
    expect(done).toBe(0);
    expect(screen.queryByTestId('paybill-question')).toBeNull();
  });

  it('leaves them a way back to their own shortcode from that screen', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({ 'POST /api/setup/paybill': (init) => { posted = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); } }));
    state.paybill = 'none';
    let done = 0;
    render(<MemoryRouter><Paybill onDone={() => { done += 1; }} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: copy.setup.paybill.haveOneNow }));
    await waitFor(() => expect(posted).toEqual({ own: true }));
    await waitFor(() => expect(done).toBe(1));
  });

  it('hides the button when the setting is blank, and changes nothing else about the screen', async () => {
    state.paybill = 'none';
    state.signupUrl = null;
    render(<MemoryRouter><Paybill onDone={() => {}} /></MemoryRouter>);
    const box = await screen.findByTestId('paybill-none');
    expect(screen.queryByTestId('signup-link')).toBeNull();
    for (const line of copy.setup.paybill.noneLines) expect(box).toHaveTextContent(line);
    expect(box).toHaveTextContent(copy.setup.paybill.noneNote);
  });
});
