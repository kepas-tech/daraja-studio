import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Questionnaire } from '../components/Questionnaire';
import { TextField } from '../components/TextField';
import { copy } from '../copy/en';

afterEach(() => cleanup());

function Demo({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [a, setA] = useState(''); const [b, setB] = useState('');
  return <Questionnaire doneLabel="Finish" onDone={onDone} onCancel={onCancel} steps={[
    { key: 'a', question: 'First?', valid: a.length > 0, render: () => <TextField label="First" labelHidden value={a} onChange={(e) => setA(e.target.value)} /> },
    { key: 'b', question: 'Second?', optional: true, valid: true, empty: !b, render: () => <TextField label="Second" labelHidden value={b} onChange={(e) => setB(e.target.value)} /> },
  ]} />;
}

describe('Questionnaire', () => {
  it('shows one question at a time with a counter, and Next only once valid', () => {
    const onDone = vi.fn();
    render(<Demo onDone={onDone} />);
    expect(screen.getByText(copy.questionnaire.of(1, 2))).toBeInTheDocument();
    expect(screen.getByText('First?')).toBeInTheDocument();
    expect(screen.queryByLabelText('Second')).not.toBeInTheDocument();
    const next = screen.getByRole('button', { name: copy.questionnaire.next });
    expect(next).toBeDisabled();
    fireEvent.change(screen.getByLabelText('First'), { target: { value: 'x' } });
    expect(next).toBeEnabled();
  });

  it('Enter advances, an empty optional question reads Finish on the last step, and Back returns with the value kept', () => {
    const onDone = vi.fn(); const onCancel = vi.fn();
    render(<Demo onDone={onDone} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: copy.questionnaire.back }));
    expect(onCancel).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('First'), { target: { value: 'x' } });
    fireEvent.submit(screen.getByLabelText('First').closest('form')!);
    expect(screen.getByText(copy.questionnaire.of(2, 2))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: copy.questionnaire.back }));
    expect(screen.getByLabelText('First')).toHaveValue('x');
    fireEvent.click(screen.getByRole('button', { name: copy.questionnaire.next }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
