import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { Done } from '../pages/setup/Done';
import { copy } from '../copy/en';

afterEach(() => cleanup());

describe('Setup › Done', () => {
  it('a 409 names the missing step and offers to go there, instead of claiming the studio is ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'incomplete', message: 'Add a working API operator first.', details: { step: 'operator' } } }), { status: 409 })));
    render(
      <MemoryRouter initialEntries={['/setup/done']}>
        <Routes>
          <Route path="/setup/done" element={<Done onDone={vi.fn()} />} />
          <Route path="/setup/operator" element={<p>operator step</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(copy.setup.done.body)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.setup.done.finish }));
    await screen.findByText(copy.setup.done.notYet);
    expect(screen.queryByText(copy.setup.done.body)).toBeNull();
    expect(screen.getByText('Add a working API operator first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.setup.done.goFix }));
    expect(screen.getByText('operator step')).toBeInTheDocument();
  });
});
