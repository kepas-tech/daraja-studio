import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NameChooser } from '../components/NameChooser';
import { copy } from '../copy/en';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('NameChooser', () => {
  it('checks a name, offers free ones when it is taken, and takes the one picked', async () => {
    const c = copy.namedNumber;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push((init?.method ?? 'GET') + ' ' + url);
      if (url.includes('name-check')) return json(200, { name: 'JOHN', available: false, reason: 'taken', message: 'Somebody on this paybill already uses that name.', suggestions: ['JOHN7', '24JOHN'] });
      if (init?.method === 'PUT') return json(200, { name: 'JOHN7' });
      throw new Error('unexpected ' + url);
    }));
    const onChanged = vi.fn();
    render(<NameChooser accountId="a1" current={null} onChanged={onChanged} />);
    fireEvent.click(screen.getByText(c.choose));
    fireEvent.change(screen.getByLabelText(c.label), { target: { value: 'john' } });
    fireEvent.click(screen.getByText(c.check));
    expect(await screen.findByText('Somebody on this paybill already uses that name.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('JOHN7'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toContain('PUT /api/accounts/a1/name');
  });

  it('shows the name in use and lets it go', async () => {
    const del = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', del);
    const onChanged = vi.fn();
    render(<NameChooser accountId="a1" current="MARY" onChanged={onChanged} />);
    expect(screen.getByText(copy.namedNumber.current('MARY'))).toBeInTheDocument();
    fireEvent.click(screen.getByText(copy.namedNumber.remove));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
