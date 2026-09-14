import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import publicUrlSource from '../pages/setup/PublicUrl.tsx?raw';
import { PublicUrl } from '../pages/setup/PublicUrl';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('Setup › PublicUrl', () => {
  it('shows the address the browser opened the studio from, read-only, and opens the field on Change', () => {
    render(<PublicUrl onDone={() => {}} onBack={() => {}} />);
    expect(screen.getByText(copy.setup.publicUrl.detected)).toBeInTheDocument();
    expect(screen.getByText(window.location.origin)).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.setup.publicUrl.field)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: copy.setup.publicUrl.change }));
    const field = screen.getByLabelText(copy.setup.publicUrl.field);
    expect(field).toHaveValue(window.location.origin);
    expect(field).toHaveAttribute('placeholder', copy.setup.publicUrl.placeholder);
    expect(screen.getByText(copy.setup.publicUrl.hint)).toBeInTheDocument();
  });

  it('has no placeholder literal in the page itself — repo rule is all copy lives in copy/en.ts', () => {
    expect(publicUrlSource).not.toContain(copy.setup.publicUrl.placeholder);
  });
});
