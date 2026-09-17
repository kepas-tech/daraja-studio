import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Nav } from '../app/Nav';
import { copy } from '../copy/en';

// The menu's badges subscribe to live events and read counts; neither is under test here.
class FakeEventSource { onopen: (() => void) | null = null; addEventListener() {} close() {} }
vi.stubGlobal('EventSource', FakeEventSource);
/** The menu reads three counts (feature 5's waiting badge, the approvals switch, the inbox); one stub answers all of them, and the URL says which. */
function stubCounts(c: { count?: number; enabled?: boolean; badge?: number; unread?: number } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/waiting/count')) return new Response(JSON.stringify({ badge: c.badge ?? 0 }), { status: 200 });
    if (url.includes('/api/notifications/count')) return new Response(JSON.stringify({ unread: c.unread ?? 0 }), { status: 200 });
    return new Response(JSON.stringify({ count: c.count ?? 0, enabled: c.enabled ?? true }), { status: 200 });
  }));
}
stubCounts();

/**
 * The one entry only the owner is offered: the audit page. These tests render Nav without a
 * session, which is a signed-out shape, so the owner-only link is correctly absent; the rule
 * itself is asserted below.
 */
const OWNER_ONLY = new Set(['who-did-what']);
const visibleToAnybody = (e: { key: string; advanced?: boolean }) => !e.advanced && !OWNER_ONLY.has(e.key);

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
    for (const e of copy.nav.filter(visibleToAnybody)) {
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
  it('shows Waiting only while approvals are on, or while something waits for a person', async () => {
    stubCounts({ enabled: false });
    const first = render(<MemoryRouter><Nav /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Send money')).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('a[href="/approvals"]')).toBeNull());
    first.unmount();
    stubCounts({ enabled: false, badge: 2 });
    render(<MemoryRouter><Nav /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector('a[href="/approvals"]')).not.toBeNull());
    expect(screen.getByText('2')).toBeInTheDocument();
    stubCounts();
  });

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
    for (const e of finished.filter(visibleToAnybody)) {
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
  it('offers the owner-only audit page to nobody else', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    expect(document.querySelector('a[href="/who-did-what"]')).toBeNull();
    expect(copy.nav.find((e) => e.key === 'who-did-what')!.available).toBe(true);
  });

  it('renders every nav entry with its Safaricom name', () => {
    render(<MemoryRouter><Nav /></MemoryRouter>);
    // Advanced destinations live on the Advanced page (advanced.test.tsx), not in the menu.
    for (const e of copy.nav.filter(visibleToAnybody)) {
      expect(screen.getByText(e.label)).toBeInTheDocument();
      if (e.safaricom) expect(screen.getByText(e.safaricom)).toBeInTheDocument();
    }
    expect(copy.nav.map((e) => e.key)).toEqual([
      'home','notifications','history','reports','stk','money-in','qr','invoices','standing-orders','express','bonga','send','contacts','bulk','approvals','reverse','businesses','who-did-what','settings','advanced','guide','not-possible',
    ]);
  });
});
