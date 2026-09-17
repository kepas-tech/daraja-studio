import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { BalanceHero } from '../components/BalanceHero';
import { copy } from '../copy/en';
import { money } from '../format';
import type { BalanceView } from '../api/types';

afterEach(() => cleanup());

const at = '2026-09-17T00:00:00Z';
const view = (over: Partial<BalanceView> = {}): BalanceView =>
  ({ workingCents: 1400, utilityCents: 3439200, chargesPaidCents: 0, queriedAt: at, waitingCents: 0, ...over });

describe('the Home balance line (feature 9)', () => {
  it('shows the Utility balance and what is still waiting to go out', () => {
    render(<BalanceHero balance={view({ waitingCents: 400000 })} />);
    expect(screen.getByText(copy.home.balanceLine.line(money(3439200), money(400000)))).toBeInTheDocument();
  });

  it('turns red and says what to do when more is waiting than Utility holds', () => {
    const { container } = render(<BalanceHero balance={view({ utilityCents: 500, waitingCents: 400000 })} />);
    const line = screen.getByText(copy.home.balanceLine.line(money(500), money(400000)));
    expect(line.className).toContain('text-danger');
    expect(screen.getByText(copy.home.balanceLine.short)).toBeInTheDocument();
    expect(container.querySelectorAll('p.text-danger')).toHaveLength(2);
  });

  it('says there is no balance instead of showing a zero', () => {
    render(<BalanceHero balance={null} />);
    expect(screen.getByText(copy.home.balanceLine.none)).toBeInTheDocument();
  });

  it('draws no line at all before the first read lands', () => {
    render(<BalanceHero balance={undefined} />);
    expect(screen.queryByText(/waiting to go out/)).toBeNull();
  });
});
