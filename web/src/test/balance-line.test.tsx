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

// Round 3, phase D-2: both float accounts, named, not one number.
describe('the Home balance line (feature 9, phase D-2)', () => {
  it('names Working and Utility beside what is still waiting to go out', () => {
    render(<BalanceHero balance={view({ waitingCents: 400000 })} />);
    expect(screen.getByText(copy.home.balanceLine.line(money(1400), money(3439200), money(400000)))).toBeInTheDocument();
  });

  it('says how much to move from Working when Utility cannot cover what is waiting', () => {
    const { container } = render(<BalanceHero balance={view({ utilityCents: 500, workingCents: 400000, waitingCents: 400000 })} />);
    const line = screen.getByText(copy.home.balanceLine.line(money(400000), money(500), money(400000)));
    expect(line.className).toContain('text-danger');
    expect(screen.getByText(copy.home.balanceLine.move(money(399500)))).toBeInTheDocument();
    expect(container.querySelectorAll('p.text-danger')).toHaveLength(2);
  });

  it('says Working cannot cover it either when it cannot', () => {
    render(<BalanceHero balance={view({ utilityCents: 500, workingCents: 1000, waitingCents: 400000 })} />);
    expect(screen.getByText(copy.home.balanceLine.notEnough)).toBeInTheDocument();
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
