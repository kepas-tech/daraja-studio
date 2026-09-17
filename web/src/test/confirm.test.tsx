import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';

afterEach(cleanup);

describe('PasswordConfirmDialog', () => {
  it('passes the typed password to onConfirm', () => {
    const onConfirm = vi.fn();
    render(<PasswordConfirmDialog open title="Send KES 500 to 0712 345 678?" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith({ password: 'pw' });
  });

  it('asks for the PIN when one is set, and hands back { pin }', () => {
    const onConfirm = vi.fn();
    render(<PasswordConfirmDialog open pin title="Send KES 500 to 0712 345 678?" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('Your PIN'), { target: { value: '246813' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith({ pin: '246813' });
  });

  it('keeps the password one tap away, and hands that back instead', () => {
    const onConfirm = vi.fn();
    render(<PasswordConfirmDialog open pin title="Send KES 500 to 0712 345 678?" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use your password instead' }));
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith({ password: 'correct horse' });
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(<PasswordConfirmDialog open title="Send KES 500 to 0712 345 678?" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('wraps focus to the password input when tabbing past Cancel while Confirm is disabled', () => {
    render(<PasswordConfirmDialog open title="Send KES 500 to 0712 345 678?" onConfirm={() => {}} onCancel={() => {}} />);
    screen.getByRole('button', { name: 'Cancel' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Your password'));
  });
});
