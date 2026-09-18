import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach } from 'vitest';
import { Guide } from '../pages/Guide';
import { copy } from '../copy/en';
import { agentSection, guide } from '../copy/guide';
import links from '../copy/safaricomLinks.json' with { type: 'json' };
import { renderGuide, renderLlms } from '../../scripts/guide-md.mjs';

afterEach(() => cleanup());

describe('How to use', () => {
  it('shows every section and every task', { timeout: 30000 }, () => {
    render(<MemoryRouter><Guide /></MemoryRouter>);
    for (const s of guide) {
      expect(screen.getByRole('heading', { level: 2, name: s.title })).toBeInTheDocument();
      for (const t of s.tasks) expect(screen.getByRole('heading', { name: t.title })).toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: copy.guidePage.login })).toBeNull();
  });

  it('shows people nothing meant for machines: no routes, no permission keys, no API calls, no agent rules, no mention of guide.md', () => {
    const { container } = render(<MemoryRouter><Guide /></MemoryRouter>);
    const text = container.textContent ?? '';
    expect(text).not.toContain('/api/');
    expect(text).not.toMatch(/Route:|Permission:|\b(stk|send|bulk|money_in|invoices|lookup|reverse|qr|bonga|express|standing_orders)\.[a-z_]+\b/);
    for (const s of guide) for (const t of s.tasks) if (t.path) expect(text).not.toContain(`Page: ${t.path}`);
    expect(text).not.toContain('guide.md');
    expect(text).not.toContain(agentSection.title);
    expect(text).not.toMatch(/never moves money/);
    expect(renderGuide()).toContain('/api/auth/login');
    expect(renderGuide()).toContain(agentSection.title);
  });

  it('logged out, it stands on its own with a way to Log in', () => {
    render(<MemoryRouter><Guide standalone /></MemoryRouter>);
    expect(screen.getByRole('link', { name: copy.guidePage.login })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('How to use Daraja Studio');
  });

  it('sits in the menu, in the help group, above Not possible via API', () => {
    const help = copy.nav.filter((e) => e.group === 'help').map((e) => e.key);
    expect(help).toEqual(['guide', 'not-possible']);
    expect(copy.nav.find((e) => e.key === 'guide')?.path).toBe('/guide');
  });

  it('every task that needs something from Safaricom links to the right site and spells out the clicks', () => {
    render(<MemoryRouter><Guide /></MemoryRouter>);
    const withLinks = guide.flatMap((s) => s.tasks).filter((t) => t.links?.length);
    expect(withLinks.map((t) => t.key)).toEqual(expect.arrayContaining(['daraja-account', 'keys', 'go-live', 'passkey', 'number', 'org-portal', 'operator', 'certificate', 'security-credential', 'url-management']));
    for (const t of withLinks) for (const l of t.links!) {
      const a = screen.getAllByRole('link', { name: l.label }).find((el) => el.getAttribute('href') === l.href);
      expect(a, `${t.key}: ${l.label}`).toBeDefined();
      expect(l.trail.length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(/Then: .+ → /).length).toBeGreaterThan(5);
    for (const t of withLinks) for (const l of t.links!) expect(Object.values(links)).toContain(l.href);
  }, 20_000); // scans every link on the whole manual; slow when the full suite runs alongside

  it('every step names a page that exists, so the manual cannot point at a route that is gone', () => {
    const routes = new Set([...copy.nav.map((e) => e.path), '/setup', '/login', '/send/phone', '/requests/:id', '/account', '/people', '/go-live', '/businesses', '/accounts/:id', '/invoices/:id']);
    for (const s of guide) for (const t of s.tasks) if (t.path) expect(routes.has(t.path), `${t.key} → ${t.path}`).toBe(true);
  });

  it('public/guide.md and public/llms.txt match the source (run: pnpm -C web guide:md)', () => {
    const pub = (f: string) => readFileSync(resolve(process.cwd(), 'public', f), 'utf8');
    expect(pub('guide.md')).toBe(renderGuide());
    expect(pub('llms.txt')).toBe(renderLlms());
  });

  it('is written in plain English', () => {
    const banned = /\b(leverage|utilize|delve|robust|seamless|pivotal|foster|harness|navigate|streamline|optimize|facilitate|enhance|comprehensive|tailored|ecosystem|synergy|paradigm|stakeholder|actionable|scalable|infrastructure|methodology|empower|elevate|unlock)\b/i;
    const text = renderGuide();
    expect(text.match(banned)).toBeNull();
  });
});
