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

  it('draws the keypad when a PIN is set, and the sixth digit hands back { pin }', () => {
    const onConfirm = vi.fn();
    render(<PasswordConfirmDialog open pin title="Send KES 500 to 0712 345 678?" onConfirm={onConfirm} onCancel={() => {}} />);
    // No confirm button at all: the keypad sends by itself (brief 2, item 5).
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    for (const d of ['2', '4', '6', '8', '1', '3']) fireEvent.click(screen.getByRole('button', { name: d }));
    expect(onConfirm).toHaveBeenCalledWith({ pin: '246813' });
  });

  it('closes from the keypad\'s Cancel key without sending anything', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<PasswordConfirmDialog open pin title="Send KES 500 to 0712 345 678?" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
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
