import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, afterEach } from 'vitest';
import { SendHub } from '../pages/send/SendHub';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('SendHub', () => {
  it('lists the seven kinds; only To a phone links, the rest say 2B', () => {
    render(<MemoryRouter><SendHub /></MemoryRouter>);
    const link = screen.getByRole('link', { name: /To a phone/ });
    expect(link).toHaveAttribute('href', '/send/phone');
    expect(screen.getAllByText(copy.send.later)).toHaveLength(6);
    expect(screen.getByText('Business Payment to Customer', { exact: false })).toBeInTheDocument();
  });
});
