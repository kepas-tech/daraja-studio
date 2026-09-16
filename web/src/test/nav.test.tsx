import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Nav } from '../app/Nav';
import { copy } from '../copy/en';

// The menu's approvals badge subscribes to live events and reads a count; neither is under test here.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);
vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0 }), { status: 200 })));

afterEach(cleanup);

describe('Nav', () => {
  // Regression, 2026-09-13: the menu was a <details>/<summary> pair. Current Chrome treats a closed
  // <details> as content-hidden, so on desktop every link was laid out and then never painted or
  // clicked, and the summary that could have opened it was hidden from md upwards. jsdom does not
  // implement that, so these assertions pin the structure rather than the painting.
  it('never uses a browser-controlled details element for the menu', () => {
    const { container } = render(<MemoryRouter><Nav /></MemoryRouter>);
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('summary')).toBeNull();
  });
  it('renders every destination without needing the menu to be opened first', () => {
    const { container } = render(<MemoryRouter><Nav /></MemoryRouter>);
    for (const e of copy.nav.filter((x) => !x.advanced)) {
      expect(container.querySelector(`a[href="${e.path}"]`)).not.toBeNull();
    }
  });
  it('opens and closes on the menu button, and reports its state', () => {
    const { container } = render(<MemoryRouter><Nav /></MemoryRouter>);
    const button = screen.getByRole('button', { name: copy.nav.menu });
    const list = container.querySelector('#nav-entries')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(list.className).toContain('hidden');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(list.className).not.toContain('hidden');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(list.className).toContain('hidden');
  });
  it('closes itself once a destination is chosen', () => {
    const { container } = render(<MemoryRouter><Nav /></MemoryRouter>);
    const button = screen.getByRole('button', { name: copy.nav.menu });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(container.querySelector('a[href="/send"]')!);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
  // The `available` flag is the ground truth for what is finished (docs/MENU-PLAN.md), so this
  // reads it rather than repeating a list of paths that goes stale the moment a slice ships — and
  // went stale silently, because a hardcoded list only fails once somebody edits it.
  it('keeps the rarely used destinations off the everyday menu and offers Advanced as a plain link to them', () => {
    render(<MemoryRouter initialEntries={['/']}><Nav /></MemoryRouter>);
    const advanced = copy.nav.filter((e) => e.advanced);
    expect(advanced.map((e) => e.key)).toEqual(['standing-orders', 'express', 'bonga', 'bulk', 'reverse']);
    for (const e of advanced) expect(document.querySelector(`a[href="${e.path}"]`)).toBeNull();
    expect(screen.getByRole('link', { name: /Advanced/ })).toHaveAttribute('href', '/advanced');
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull();
  });

  it('marks unfinished destinations without marking available pages', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    const unfinished = copy.nav.filter((e) => !e.available);
    const finished = copy.nav.filter((e) => e.available);
    // Every menu item shipped on 2026-09-16, so `unfinished` may be empty; the loop below still guards a regression.
    expect(finished.length).toBeGreaterThan(0);
    for (const e of unfinished) {
      const link = document.querySelector<HTMLAnchorElement>(`a[href="${e.path}"]`)!;
      expect(within(link).getByText('Coming soon')).toBeInTheDocument();
    }
    for (const e of finished.filter((x) => !x.advanced)) {
      const link = document.querySelector<HTMLAnchorElement>(`a[href="${e.path}"]`)!;
      expect(within(link).queryByText('Coming soon')).not.toBeInTheDocument();
    }
  });

  // The one assertion that must name the slice: M1 shipped, so this label is gone for good.
  it('Ask a customer to pay is finished, and no longer says Coming soon', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    const link = document.querySelector<HTMLAnchorElement>('a[href="/ask-to-pay"]')!;
    expect(within(link).queryByText('Coming soon')).not.toBeInTheDocument();
    expect(copy.nav.find((e) => e.key === 'stk')!.available).toBe(true);
  });
  it('renders every nav entry with its Safaricom name', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    // Advanced destinations live on the Advanced page (advanced.test.tsx), not in the menu.
    for (const e of copy.nav.filter((x) => !x.advanced)) {
      expect(screen.getByText(e.label)).toBeInTheDocument();
      if (e.safaricom) expect(screen.getByText(e.safaricom)).toBeInTheDocument();
    }
    expect(copy.nav.map((e) => e.key)).toEqual([
      'home','history','stk','money-in','qr','invoices','standing-orders','express','bonga','send','bulk','approvals','reverse','settings','advanced','not-possible',
    ]);
  });
});
