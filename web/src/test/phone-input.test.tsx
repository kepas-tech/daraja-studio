import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PhoneInput } from '../components/PhoneInput';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('PhoneInput', () => {
  it('echoes the normalised number and flags junk', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PhoneInput label="Phone number" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+254 792 471415' } });
    expect(onChange).toHaveBeenCalledWith('+254 792 471415');
    rerender(<PhoneInput label="Phone number" value="+254 792 471415" onChange={onChange} />);
    expect(screen.getByText('0792 471 415')).toBeInTheDocument();
    rerender(<PhoneInput label="Phone number" value="12345" onChange={onChange} />);
    expect(screen.getByText(copy.send.phone.badPhone)).toBeInTheDocument();
  });
});
