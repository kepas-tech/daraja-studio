import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach } from 'vitest';
import { Guide } from '../pages/Guide';
import { copy } from '../copy/en';
import { agentSection, guide } from '../copy/guide';
import { renderGuide, renderLlms } from '../../scripts/guide-md.mjs';

afterEach(() => cleanup());

describe('How to use', () => {
  it('shows every section, every task and the rules for AI agents', () => {
    render(<MemoryRouter><Guide /></MemoryRouter>);
    for (const s of guide) {
      expect(screen.getByRole('heading', { level: 2, name: s.title })).toBeInTheDocument();
      for (const t of s.tasks) expect(screen.getByRole('heading', { name: t.title })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 2, name: agentSection.title })).toBeInTheDocument();
    expect(screen.getAllByText(/never moves money/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\/guide\.md/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.guidePage.login })).toBeNull();
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

  it('every step names a page that exists, so the manual cannot point at a route that is gone', () => {
    const routes = new Set([...copy.nav.map((e) => e.path), '/setup', '/login', '/send/phone', '/requests/:id', '/account', '/people']);
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
