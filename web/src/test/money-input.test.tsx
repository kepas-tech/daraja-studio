import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MoneyInput } from '../components/MoneyInput';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('MoneyInput', () => {
  it('emits cents as the user types and shows the whole-shilling rule', () => {
    const onChange = vi.fn();
    render(<MoneyInput label="Amount (KES)" valueCents={null} onChange={onChange} wholeShillings />);
    expect(screen.getByText(copy.send.phone.wholeShillings)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Amount \(KES\)/), { target: { value: '1,234' } });
    expect(onChange).toHaveBeenLastCalledWith(123400);
    fireEvent.change(screen.getByLabelText(/^Amount \(KES\)/), { target: { value: '12.50' } });
    expect(onChange).toHaveBeenLastCalledWith(1250);
    expect(screen.getByText(copy.send.phone.centsNotAllowed)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Amount \(KES\)/)).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText(/^Amount \(KES\)/), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('resyncs its text to an externally changed valueCents', () => {
    const onChange = vi.fn();
    const { rerender } = render(<MoneyInput label="Amount (KES)" valueCents={100} onChange={onChange} />);
    expect(screen.getByLabelText(/^Amount \(KES\)/)).toHaveValue('1');
    rerender(<MoneyInput label="Amount (KES)" valueCents={null} onChange={onChange} />);
    expect(screen.getByLabelText(/^Amount \(KES\)/)).toHaveValue('');
    rerender(<MoneyInput label="Amount (KES)" valueCents={2500} onChange={onChange} />);
    expect(screen.getByLabelText(/^Amount \(KES\)/)).toHaveValue('25');
  });
});
