import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Org } from '../pages/setup/Org';
import { copy } from '../copy/en';
import { answer } from './questionnaire';

afterEach(() => cleanup());

const validForm = { name: 'APIONE', nominatedNumber: '254712345678', notificationPhone: '254712345678' };

function fillAndSubmit() {
  answer(copy.setup.org.name, validForm.name);
  answer(copy.setup.org.nominated, validForm.nominatedNumber);
  fireEvent.change(screen.getByLabelText(copy.setup.org.notify), { target: { value: validForm.notificationPhone } });
  fireEvent.click(screen.getByRole('button', { name: copy.setup.next }));
}

describe('Setup › Org', () => {
  it('posts name and phones, with no shortcode field', async () => {
    let body: unknown = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    render(<Org onDone={onDone} onBack={() => {}} />);

    expect(screen.queryByLabelText(copy.setup.shortcode.field)).not.toBeInTheDocument();
    fillAndSubmit();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/setup/org', expect.objectContaining({ method: 'POST' })));
    expect(body).toEqual(validForm);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('shows a server error and calls onBack', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'invalid', message: 'nope' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const onBack = vi.fn();
    render(<Org onDone={() => {}} onBack={onBack} />);

    fillAndSubmit();
    await screen.findByRole('alert');

    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: copy.setup.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
