import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Shortcode } from '../pages/setup/Shortcode';
import { ToastHost } from '../components/Toast';
import { copy } from '../copy/en';

// This file's vitest config does not set `test.globals: true`, so Testing
// Library's automatic per-test cleanup never registers — clean up explicitly.
afterEach(() => { cleanup(); vi.useRealTimers(); });

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ verifiedName: 'APIONE', verifyError: null }), { status: 200 }));
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(copy.setup.shortcode.field), { target: { value: '400500' } });
  fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));
}

// setTimeout(onDone, 800) is scheduled only after the POST promise chain
// (fetch → r.text() → JSON.parse) resolves. Fake timers don't touch the
// microtask queue those awaits run on, so draining it a few times lets the
// scheduling happen before we advance the (fake) 800ms clock.
async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('Setup › Shortcode post-success timer', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('does not call onDone if the component unmounts before the 800ms delay elapses', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const onDone = vi.fn();
    const { unmount } = render(<Shortcode onDone={onDone} onBack={() => {}} />);

    fillAndSubmit();
    await act(async () => { await flushMicrotasks(); });
    expect(screen.getByText(copy.setup.shortcode.verified('APIONE'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.setup.next })).toBeDisabled();

    unmount();
    act(() => { vi.advanceTimersByTime(2000); });

    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onDone once, 800ms after a successful post, if still mounted', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const onDone = vi.fn();
    render(<Shortcode onDone={onDone} onBack={() => {}} />);

    fillAndSubmit();
    await act(async () => { await flushMicrotasks(); });
    expect(screen.getByText(copy.setup.shortcode.verified('APIONE'))).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(800); });

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('toasts the verified name on success', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<><ToastHost /><Shortcode onDone={() => {}} onBack={() => {}} /></>);

    fillAndSubmit();
    await act(async () => { await flushMicrotasks(); });

    expect(screen.getByRole('status')).toHaveTextContent(copy.setup.shortcode.verified('APIONE'));
  });

  it('keeps the Next button disabled through the post-success wait, and re-enables it only on error', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'nope' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<Shortcode onDone={() => {}} onBack={() => {}} />);

    fillAndSubmit();
    await act(async () => { await flushMicrotasks(); });

    expect(screen.getByRole('button', { name: copy.setup.next })).not.toBeDisabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
