import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Uses } from '../pages/setup/Uses';
import { Passkey } from '../pages/setup/Passkey';
import { copy } from '../copy/en';

afterEach(() => cleanup());

function fetchFor(handlers: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected fetch ${key}`);
    return h(init);
  });
}

describe('Uses', () => {
  it('cannot continue until something is chosen, and sends both answers', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'POST /api/setup/uses': (init) => { posted = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); },
    }));
    const onDone = vi.fn();
    render(<Uses onDone={onDone} />);

    expect(screen.getByRole('button', { name: copy.setup.next })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(copy.setup.uses.collect, { exact: false }));
    expect(screen.getByRole('button', { name: copy.setup.next })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // An unticked box is a real "no", not an absence — the server stores it as one.
    expect(posted).toEqual({ payOut: false, collect: true });
  });

  it('asks in plain words, and puts Safaricom\'s name underneath rather than in the question', () => {
    vi.stubGlobal('fetch', fetchFor({}));
    render(<Uses onDone={vi.fn()} />);
    expect(screen.getByText(copy.setup.uses.collect)).toBeInTheDocument();
    expect(screen.getByText(copy.setup.uses.collectSafaricom)).toBeInTheDocument();
    // The question itself must never be the jargon.
    expect(copy.setup.uses.collect).not.toMatch(/STK|B2C/i);
    expect(copy.setup.uses.payOut).not.toMatch(/STK|B2C/i);
  });
});

describe('Passkey', () => {
  const fill = () => {
    fireEvent.change(screen.getByLabelText(copy.setup.passkey.field, { exact: false }), { target: { value: 'k'.repeat(64) } });
    fireEvent.change(screen.getByLabelText(copy.setup.passkey.phone, { exact: false }), { target: { value: '0792471415' } });
  };

  it('tests the passkey against Safaricom and moves on only when it is proven', async () => {
    let posted: unknown = null;
    vi.stubGlobal('fetch', fetchFor({
      'POST /api/setup/passkey': (init) => { posted = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ proven: true, requestId: 'r1' }), { status: 200 }); },
    }));
    const onDone = vi.fn();
    render(<Passkey onDone={onDone} onBack={vi.fn()} />);

    expect(screen.getByRole('button', { name: copy.setup.passkey.test })).toBeDisabled();
    fill();
    fireEvent.click(screen.getByRole('button', { name: copy.setup.passkey.test }));

    await screen.findByText(copy.setup.passkey.proven);
    expect(posted).toEqual({ passkey: 'k'.repeat(64), phone: '254792471415' });
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));
    expect(onDone).toHaveBeenCalled();
  });

  it('a refused passkey stops here and says nothing was charged — the wrong-passkey case', async () => {
    // Safaricom refuses a wrong passkey at the acknowledgement, so no prompt reaches the phone.
    // The whole point of this screen is that it cannot be passed on a value Safaricom rejected.
    vi.stubGlobal('fetch', fetchFor({
      'POST /api/setup/passkey': () => new Response(JSON.stringify({ proven: false, requestId: 'r2' }), { status: 200 }),
    }));
    const onDone = vi.fn();
    render(<Passkey onDone={onDone} onBack={vi.fn()} />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: copy.setup.passkey.test }));

    await screen.findByText(copy.setup.passkey.failedTitle);
    expect(screen.getByText(copy.setup.passkey.failedBody)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: copy.setup.next })).toBeNull();
    expect(screen.getByRole('button', { name: copy.setup.passkey.retry })).toBeInTheDocument();
  });

  it('says plainly that the test goes to your own phone and may be cancelled', () => {
    vi.stubGlobal('fetch', fetchFor({}));
    render(<Passkey onDone={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(copy.setup.passkey.testBody)).toBeInTheDocument();
    expect(screen.getByText(copy.setup.passkey.phoneHelp)).toBeInTheDocument();
  });

  it('going back does not call onDone', () => {
    vi.stubGlobal('fetch', fetchFor({}));
    const onBack = vi.fn();
    render(<Passkey onDone={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: copy.setup.back }));
    expect(onBack).toHaveBeenCalled();
  });
});
