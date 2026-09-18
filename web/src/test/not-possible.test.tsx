import { render, screen, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach } from 'vitest';
import { NotPossible } from '../pages/NotPossible';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('NotPossible', () => {
  it('renders all 16 cards with portal paths', () => {
    render(<MemoryRouter><NotPossible /></MemoryRouter>);
    expect(copy.notPossible.length).toBe(16);
    expect(screen.getAllByRole('article').length).toBe(16);
    expect(screen.getByText('*234*4#')).toBeInTheDocument();
  });

  // Round 3, phase D-9: airtime is on this page because the API has no command for it, with the
  // portal path and the phone code where it is really bought.
  it('says where airtime is bought, and why it is not bought here', () => {
    render(<MemoryRouter><NotPossible /></MemoryRouter>);
    const card = screen.getByRole('heading', { name: 'Buy airtime' }).closest('article')!;
    expect(card).toHaveTextContent('no airtime command');
    expect(within(card).getByText('*544#')).toBeInTheDocument();
    expect(card).toHaveTextContent('Business Center › Buy Airtime');
  });
});
