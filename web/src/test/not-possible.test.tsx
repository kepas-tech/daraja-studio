import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import { NotPossible } from '../pages/NotPossible';
import { copy } from '../copy/en';

describe('NotPossible', () => {
  it('renders all 15 cards with portal paths', () => {
    render(<MemoryRouter><NotPossible /></MemoryRouter>);
    expect(copy.notPossible.length).toBe(15);
    expect(screen.getAllByRole('article').length).toBe(15);
    expect(screen.getByText('*234*4#')).toBeInTheDocument();
  });
});
