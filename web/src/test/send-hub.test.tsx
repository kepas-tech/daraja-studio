import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach } from 'vitest';
import { SendHub } from '../pages/send/SendHub';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('SendHub', () => {
  it('lists the eight kinds; a phone, a paybill and a till link, the rest are planned', () => {
    render(<MemoryRouter><SendHub /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /To a phone/ })).toHaveAttribute('href', '/send/phone');
    expect(screen.getByRole('link', { name: /To a paybill/ })).toHaveAttribute('href', '/send/paybill');
    expect(screen.getByRole('link', { name: /To a till/ })).toHaveAttribute('href', '/send/till');
    expect(screen.getAllByText(copy.send.later)).toHaveLength(5);
    expect(screen.getByText('Business Payment to Customer', { exact: false })).toBeInTheDocument();
  });

  // Round 3, phase D-9: airtime is listed, and it says the real reason rather than promising a
  // day that cannot come — Safaricom's M-Pesa API has no airtime command.
  it('lists airtime among the planned kinds, with the reason and where it is really bought', () => {
    render(<MemoryRouter><SendHub /></MemoryRouter>);
    const row = screen.getByTestId('planned-airtime');
    expect(row).toHaveTextContent(copy.send.kinds.find((k) => k.key === 'airtime')!.label);
    expect(row).toHaveTextContent('no airtime command');
    expect(within(row).getByRole('link', { name: copy.send.where })).toHaveAttribute('href', '/not-possible');
    // The other planned kinds are only unbuilt, and say nothing extra.
    expect(screen.getByTestId('planned-kra')).not.toHaveTextContent(copy.send.where);
  });
});
