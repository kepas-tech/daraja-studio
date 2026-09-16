import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach } from 'vitest';
import { Advanced } from '../pages/Advanced';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('Advanced page', () => {
  it('lists every advanced destination as a card that opens the real page, grouped as the menu groups them', () => {
    render(<MemoryRouter><Advanced /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1, name: copy.advancedPage.title })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: copy.nav.groups.in! })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: copy.nav.groups.out! })).toBeInTheDocument();
    for (const e of copy.nav.filter((x) => x.advanced)) {
      const link = screen.getByRole('link', { name: new RegExp(e.label) });
      expect(link).toHaveAttribute('href', e.path);
      expect(link).toHaveTextContent(copy.advancedPage.blurbs[e.key]!);
    }
  });
});
