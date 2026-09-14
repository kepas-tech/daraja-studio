import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import publicUrlSource from '../pages/setup/PublicUrl.tsx?raw';
import { PublicUrl } from '../pages/setup/PublicUrl';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('Setup › PublicUrl', () => {
  it('renders its field placeholder from copy', () => {
    render(<PublicUrl onDone={() => {}} onBack={() => {}} />);
    expect(screen.getByLabelText(copy.setup.publicUrl.field)).toHaveAttribute('placeholder', copy.setup.publicUrl.placeholder);
  });

  it('has no placeholder literal in the page itself — repo rule is all copy lives in copy/en.ts', () => {
    expect(publicUrlSource).not.toContain(copy.setup.publicUrl.placeholder);
  });
});
