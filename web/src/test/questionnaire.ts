import { fireEvent, screen } from '@testing-library/react';
import { copy } from '../copy/en';

/** Type an answer into the question on screen and press Next. */
export function answer(label: string, value: string, opts: { exact?: boolean } = {}) {
  fireEvent.change(screen.getByLabelText(label, opts), { target: { value } });
  next();
}
/** Press the questionnaire's Next (or Skip) button. */
export function next() {
  const btn = screen.queryByRole('button', { name: copy.questionnaire.next }) ?? screen.getByRole('button', { name: copy.questionnaire.skip });
  fireEvent.click(btn);
}
