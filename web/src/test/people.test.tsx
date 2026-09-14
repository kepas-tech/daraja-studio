import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { People } from '../pages/People';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';
import { answer, next } from './questionnaire';

afterEach(() => cleanup());

const owner = { id: 'p1', username: 'owner@one.co.ke', displayName: 'Owner One', email: 'owner@one.co.ke', role: 'owner', status: 'active', isOwner: true, isHostAdmin: false, mustChangePassword: false, createdAt: '2026-09-01T08:00:00Z', lastLoginAt: '2026-09-09T06:00:00Z' };
const viewer = { ...owner, id: 'p2', username: 'aisha@one.co.ke', displayName: 'Aisha', email: 'aisha@one.co.ke', role: 'viewer', isOwner: false, mustChangePassword: true, lastLoginAt: null };

// A handler always wins over the default list, so a test can make `GET /api/people` refuse.
function mount(handlers: Record<string, (init?: RequestInit) => Response>, people = [owner, viewer]) {
  let list = people;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (h) return h(init);
    if (key === 'GET /api/people') return new Response(JSON.stringify(list), { status: 200 });
    throw new Error(`unexpected fetch ${key}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><People /><ToastHost /></MemoryRouter>);
  return { fetchMock, setList: (next: typeof people) => { list = next; } };
}

async function confirmWithPassword() {
  fireEvent.change(await screen.findByLabelText(copy.confirm.yourPassword), { target: { value: 'owner-password' } });
  fireEvent.click(screen.getByRole('button', { name: copy.confirm.confirm }));
}

describe('People', () => {
  it('keeps custom roles visible but unavailable until permission editing exists', async () => {
    mount({}, [owner, { ...viewer, role: 'custom' }]);
    const existing = within(await screen.findByTestId('person-p2')).getByRole('combobox');
    expect(existing).toHaveValue('custom');
    expect(within(existing).getByRole('option', { name: /Custom/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: copy.people.add }));
    answer(copy.people.displayName, 'Joe');
    answer(copy.people.usernameSingle, 'joe');
    expect(screen.getByLabelText(copy.people.roles.viewer!)).toBeChecked();
    expect(screen.getByLabelText(copy.people.roles.operator!)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Custom/)).not.toBeInTheDocument();
  });
  it('lists everybody with their role and whether they are switched on', async () => {
    mount({});
    await screen.findByText('Owner One');
    expect(screen.getByText('Aisha')).toBeInTheDocument();
    expect(screen.getByText(copy.people.roles.owner)).toBeInTheDocument();
    expect(screen.getByText(copy.people.roles.viewer)).toBeInTheDocument();
    expect(screen.getByText(copy.people.mustChange)).toBeInTheDocument();
  });

  it('adds a person and shows the temporary password exactly once', async () => {
    let posted: { username?: string; temporaryPassword?: string; password?: string } | null = null;
    const t = mount({
      'POST /api/people': (init) => {
        posted = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ...viewer, id: 'p3', username: 'joe@one.co.ke', displayName: 'Joe', email: 'joe@one.co.ke', role: 'operator' }), { status: 201 });
      },
    });
    await screen.findByText('Owner One');
    fireEvent.click(screen.getByRole('button', { name: copy.people.add }));
    answer(copy.people.displayName, 'Joe');
    answer(copy.people.usernameSingle, 'joe@one.co.ke');
    fireEvent.click(screen.getByLabelText(copy.people.roles.operator!));
    next();
    const suggested = (screen.getByLabelText(copy.people.temporaryPassword) as HTMLInputElement).value;
    expect(suggested.length).toBeGreaterThanOrEqual(12);
    t.setList([owner, viewer, { ...viewer, id: 'p3', username: 'joe@one.co.ke', displayName: 'Joe', role: 'operator' }]);
    fireEvent.click(screen.getByRole('button', { name: copy.people.addButton }));
    await confirmWithPassword();

    const panel = await screen.findByRole('status');
    expect(panel).toHaveTextContent(copy.people.tellThem);
    expect(panel).toHaveTextContent(suggested);
    expect(posted).toMatchObject({ username: 'joe@one.co.ke', temporaryPassword: suggested, password: 'owner-password' });

    fireEvent.click(screen.getByRole('button', { name: copy.people.gotIt }));
    await waitFor(() => expect(screen.queryByText(suggested)).not.toBeInTheDocument());
  });

  it('shows the server\'s refusal when the address is taken', async () => {
    mount({
      'POST /api/people': () => new Response(JSON.stringify({ error: { code: 'username_taken', message: 'Somebody on this service already uses that name or address.' } }), { status: 409 }),
    });
    await screen.findByText('Owner One');
    fireEvent.click(screen.getByRole('button', { name: copy.people.add }));
    answer(copy.people.displayName, 'Joe');
    answer(copy.people.usernameSingle, 'aisha@one.co.ke');
    next();
    fireEvent.click(screen.getByRole('button', { name: copy.people.addButton }));
    await confirmWithPassword();
    expect(await screen.findByRole('alert')).toHaveTextContent('already uses that name or address');
  });

  it('changes a role behind the password dialog', async () => {
    let put: unknown = null;
    mount({
      'PUT /api/people/p2/role': (init) => { put = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ ...viewer, role: 'operator' }), { status: 200 }); },
    });
    const row = within(await screen.findByTestId('person-p2'));
    fireEvent.change(row.getByLabelText(copy.people.roleFor('Aisha')), { target: { value: 'operator' } });
    await confirmWithPassword();
    await waitFor(() => expect(put).toEqual({ role: 'operator', password: 'owner-password' }));
  });

  it('resets a password and shows the new one once', async () => {
    let posted: { temporaryPassword?: string } = {};
    mount({
      'POST /api/people/p2/reset-password': (init) => { posted = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); },
    });
    const row = within(await screen.findByTestId('person-p2'));
    fireEvent.click(row.getByRole('button', { name: copy.people.reset }));
    await confirmWithPassword();
    const panel = await screen.findByRole('status');
    expect(panel).toHaveTextContent(copy.people.tellThem);
    expect(panel).toHaveTextContent(String(posted.temporaryPassword));
  });

  it('suspends and resumes', async () => {
    let suspended = 0;
    let resumed = 0;
    const t = mount({
      'POST /api/people/p2/suspend': () => { suspended++; return new Response(null, { status: 204 }); },
      'POST /api/people/p2/resume': () => { resumed++; return new Response(null, { status: 204 }); },
    });
    let row = within(await screen.findByTestId('person-p2'));
    t.setList([owner, { ...viewer, status: 'suspended' }]);
    fireEvent.click(row.getByRole('button', { name: copy.people.suspend }));
    await confirmWithPassword();
    await waitFor(() => expect(suspended).toBe(1));
    row = within(await screen.findByTestId('person-p2'));
    await waitFor(() => expect(row.getByRole('button', { name: copy.people.resume })).toBeInTheDocument());
    t.setList([owner, viewer]);
    fireEvent.click(row.getByRole('button', { name: copy.people.resume }));
    await confirmWithPassword();
    await waitFor(() => expect(resumed).toBe(1));
  });

  it('offers nothing to do to the owner\'s own row', async () => {
    mount({});
    const row = within(await screen.findByTestId('person-p1'));
    expect(row.queryByRole('button', { name: copy.people.suspend })).not.toBeInTheDocument();
    expect(row.queryByRole('button', { name: copy.people.reset })).not.toBeInTheDocument();
    expect(row.getByText(copy.people.ownerNote)).toBeInTheDocument();
  });

  it('says plainly that this page belongs to the owner', async () => {
    mount({ 'GET /api/people': () => new Response(JSON.stringify({ error: { code: 'owner_only', message: 'Only the owner can do this.' } }), { status: 403 }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner can do this.');
  });
});
