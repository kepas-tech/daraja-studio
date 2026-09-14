import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ToastHost, useToast } from '../components/Toast';
import { copy } from '../copy/en';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ToastHost / useToast', () => {
  it('shows a success toast with role="status"', () => {
    render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => { result.current.success('Saved.'); });
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('Saved.');
  });

  it('shows an error toast with role="alert"', () => {
    render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => { result.current.error('Something failed.'); });
    const el = screen.getByRole('alert');
    expect(el).toHaveTextContent('Something failed.');
  });

  it('stacks at most 3, newest at the bottom', () => {
    render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.info('one');
      result.current.info('two');
      result.current.info('three');
      result.current.info('four');
    });
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(3);
    for (const text of ['two', 'three', 'four']) expect(statuses.some((s) => s.textContent?.includes(text))).toBe(true);
    expect(statuses[statuses.length - 1]!.textContent).toContain('four');
  });

  it('auto-dismisses a success toast after 4s', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => { result.current.success('Saved.'); });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3999); });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps an error toast up to 8s, longer than success', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => { result.current.error('Failed.'); });
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pauses auto-dismiss on hover', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => { result.current.success('Saved.'); });
    const el = screen.getByRole('status');
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('closes on the close button, labelled from copy', () => {
    render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => { result.current.info('Hello.'); });
    fireEvent.click(screen.getByRole('button', { name: copy.toast.close }));
    expect(screen.queryByText('Hello.')).not.toBeInTheDocument();
  });

  it('clears pending toasts when the host unmounts, so the next mount starts empty', () => {
    const { unmount } = render(<ToastHost />);
    const { result } = renderHook(() => useToast());
    act(() => { result.current.info('Leftover.'); });
    expect(screen.getByText('Leftover.')).toBeInTheDocument();
    unmount();
    render(<ToastHost />);
    expect(screen.queryByText('Leftover.')).not.toBeInTheDocument();
  });
});
