import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WhoDidWhat } from '../pages/WhoDidWhat';
import { copy } from '../copy/en';

class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const people = [{
  id: 'p1', username: 'amina', displayName: 'Amina', email: null, role: 'operator', status: 'active',
  isOwner: false, isHostAdmin: false, mustChangePassword: false, createdAt: '2026-09-01T00:00:00Z', lastLoginAt: null,
}];

/** Two rows: one a person made, one a job made, so both shapes of the "Who" column are covered. */
const rows = [
  { id: '31', at: '2026-09-16T09:00:00.000Z', action: 'settings.set', person: { id: 'p1', displayName: 'Amina' }, target: 'org.name', before: { name: 'Old name' }, after: { name: 'New name' }, ip: '127.0.0.1' },
  { id: '30', at: '2026-09-16T08:00:00.000Z', action: 'operator.rotated', person: null, target: 'APIONE', before: null, after: { rotated: true }, ip: null },
];

afterEach(cleanup);

function mount(opts: { items?: unknown[]; nextCursor?: string | null; audit?: () => Response; people?: () => Response } = {}) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); urls.push(url);
    if (url === '/api/people') return (opts.people ?? (() => json(people)))();
    if (url === '/api/audit/actions') return json({ items: ['operator.rotated', 'settings.set'] });
    if (url.startsWith('/api/audit?')) return (opts.audit ?? (() => json({ items: opts.items ?? rows, nextCursor: opts.nextCursor ?? null })))();
    throw new Error('unexpected fetch ' + url);
  }));
  render(<MemoryRouter><WhoDidWhat /></MemoryRouter>);
  const lastAudit = () => [...urls].reverse().find((u) => u.startsWith('/api/audit?')) ?? '';
  return { urls, lastAudit };
}

describe('Who did what', () => {
  it('shows who did what, to what, and says when nobody signed in', async () => {
    mount();
    // The filter lists load first; the rows arrive after the page's own short debounce, so every
    // assertion below is scoped to a row rather than to the whole page.
    const first = await screen.findByTestId('audit-31');
    const cells = within(first).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('Amina');
    expect(cells[2]).toHaveTextContent('settings.set');
    expect(cells[3]).toHaveTextContent('org.name');

    // The job's own row carries no person, so the column says so rather than showing a blank.
    const second = await screen.findByTestId('audit-30');
    const other = within(second).getAllByRole('cell');
    expect(other[1]).toHaveTextContent(copy.whoDidWhat.nobody);
    expect(other[3]).toHaveTextContent('APIONE');
  });

  it('asks again with the person, the action, the dates and the search text it was given', async () => {
    const { lastAudit } = mount();
    await screen.findByTestId('audit-31');

    fireEvent.change(screen.getByLabelText(copy.whoDidWhat.search), { target: { value: 'org.name' } });
    fireEvent.change(await screen.findByLabelText(copy.whoDidWhat.person), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText(copy.whoDidWhat.action), { target: { value: 'settings.set' } });
    fireEvent.change(screen.getByLabelText(copy.whoDidWhat.from), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText(copy.whoDidWhat.to), { target: { value: '2026-09-16' } });

    await waitFor(() => {
      const url = lastAudit();
      expect(url).toContain('q=org.name');
      expect(url).toContain('personId=p1');
      expect(url).toContain('action=settings.set');
      expect(url).toContain('from=2026-09-01');
      expect(url).toContain('to=2026-09-16');
    });
  });

  it('opens a line to show the values before and after, and the address it came from', async () => {
    mount();
    const first = await screen.findByTestId('audit-31');
    fireEvent.click(within(first).getByRole('button', { name: copy.whoDidWhat.show }));

    expect(await screen.findByText(copy.whoDidWhat.before)).toBeInTheDocument();
    expect(screen.getByText(/"New name"/)).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1')).toBeInTheDocument();

    // The row with no stored JSON says so, and the row with no address records none.
    const second = screen.getByTestId('audit-30');
    fireEvent.click(within(second).getByRole('button', { name: copy.whoDidWhat.show }));
    await waitFor(() => expect(screen.getByText(copy.whoDidWhat.noAddress)).toBeInTheDocument());
    expect(screen.getAllByText(copy.whoDidWhat.nothing).length).toBeGreaterThan(0);
  });

  it('shows the explained refusal when the server says only the owner may look', async () => {
    mount({
      audit: () => json({ error: { code: 'owner_only', message: 'Only the owner can do this.' } }, 403),
      people: () => json({ error: { code: 'owner_only', message: 'Only the owner can do this.' } }, 403),
    });
    expect(await screen.findByText('Only the owner can do this.')).toBeInTheDocument();
  });

  it('walks to the next page with the cursor the server sent', async () => {
    const { lastAudit } = mount({ nextCursor: 'next-page' });
    await screen.findByTestId('audit-31');
    fireEvent.click(screen.getByRole('button', { name: copy.whoDidWhat.next }));
    await waitFor(() => expect(lastAudit()).toContain('cursor=next-page'));
    // The page number is the stack we came through, exactly as History counts it.
    expect(screen.getByText(copy.whoDidWhat.page(2))).toBeInTheDocument();
  });
});
